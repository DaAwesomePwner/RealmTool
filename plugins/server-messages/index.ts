import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';

const QUIET_NOTIFICATION_KEYS = new Set(['s.plus_symbol']);

interface Session {
  started: number;
  position?: { x: number; y: number };
  moved?: number;
  shot?: number;
  usedItem?: number;
  chatted?: number;
  messagesLogged: number;
  suppressed: number;
  lastMessage: string;
}

function sanitize(message: string): string {
  const line = message.replace(/[\r\n]+/g, ' ');
  return line.length > 500 ? line.slice(0, 499) + '…' : line;
}

/** Best-effort text recovery only: NOTIFICATION's trailing schema is unknown. */
function notificationStrings(bytes: Buffer): string {
  // Bound speculative length-prefix decoding and UTF-8 recovery on unknown payloads.
  bytes = bytes.subarray(0, 4096);
  const strings: string[] = [];
  const addRuns = (part: Buffer): void => {
    for (const match of part.toString('utf8').matchAll(/[^\p{C}\uFFFD]{4,}/gu)) strings.push(match[0]);
  };
  let rawStart = 0;
  for (let offset = 0; offset + 2 <= bytes.length; offset++) {
    const length = bytes.readUInt16BE(offset);
    const end = offset + 2 + length;
    if (!length || end > bytes.length) continue;
    const candidate = bytes.subarray(offset + 2, end).toString('utf8');
    if (/[\p{C}\uFFFD]/u.test(candidate)) continue;
    addRuns(bytes.subarray(rawStart, offset));
    strings.push(candidate);
    rawStart = end;
    offset = end - 1;
  }
  addRuns(bytes.subarray(rawStart));
  return [...new Set(strings)].join(' | ');
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function register(ctx: PluginContext): void {
  ctx.name = 'Server Messages';
  ctx.category = 'utility';
  ctx.registerSetting('logSystemMessages', { label: 'Log system messages', type: 'boolean', value: true });
  const sessions = new Map<ClientConnection, Session>();
  const publish = (client: ClientConnection, session: Session): void => {
    ctx.setData('status', { sessionId: client.clientId.slice(0, 8), messagesLogged: session.messagesLogged, lastMessage: session.lastMessage, suppressed: session.suppressed });
  };
  function sessionFor(client: ClientConnection): Session {
    let session = sessions.get(client);
    if (!session) {
      // Also supports enabling the plugin during an existing connection.
      session = { started: performance.now(), messagesLogged: 0, lastMessage: '', suppressed: 0 };
      sessions.set(client, session);
    }
    return session;
  }
  ctx.setData('status', { messagesLogged: 0, lastMessage: '', suppressed: 0 });
  ctx.on('clientConnected', client => {
    if (ctx.enabled) publish(client, sessionFor(client));
  });
  ctx.on('clientDisconnected', client => {
    const session = sessions.get(client);
    sessions.delete(client);
    if (!ctx.enabled || !session) return;
    const now = performance.now();
    const idle = (at: number | undefined): string => at === undefined ? 'never' : `${duration(now - at)} ago`;
    const summary = session.suppressed ? `; suppressed ${session.suppressed} "+N" notifications` : '';
    ctx.log(sanitize(`[${client.clientId.slice(0, 8)}] Session ended after ${duration(now - session.started)}; idle: moved ${idle(session.moved)}, shot ${idle(session.shot)}, used item ${idle(session.usedItem)}, chatted ${idle(session.chatted)}${summary}`));
  });
  ctx.onEnabledChange(() => {
    sessions.clear();
    ctx.setData('status', { messagesLogged: 0, lastMessage: '', suppressed: 0 });
  });
  ctx.registerCleanup(() => sessions.clear());

  for (const name of ['FAILURE', 'GLOBALNOTIFICATION', 'NOTIFICATION', 'TEXT']) {
    ctx.observePacket(name, (client, packet) => {
      if (!ctx.enabled || !ctx.getSetting<boolean>('logSystemMessages') || packet.direction !== 'server' || !packet.isDefined) return;
      const d = packet.data;
      let message: string;
      switch (name) {
        case 'FAILURE': message = `FAILURE ${d.errorId}: ${d.errorMessage}`; break;
        case 'GLOBALNOTIFICATION': message = `GLOBALNOTIFICATION ${d.notificationType}: ${d.text}`; break;
        case 'NOTIFICATION': {
          // Effect 5 is the realm queue: int32 message type, int16 position (RealmShark NotificationPacket).
          const text = d.typeValue === 5 && packet.unreadData.length >= 6
            ? `queue message ${packet.unreadData.readInt32BE(0)}, position ${packet.unreadData.readInt16BE(4)}`
            : notificationStrings(packet.unreadData);
          // Localization payloads can contain trailing commas, so extract keys without JSON parsing.
          const quiet = [...text.matchAll(/"k"\s*:\s*"([^"\\]*)"/g)].some(match => QUIET_NOTIFICATION_KEYS.has(match[1]!));
          if (quiet) {
            const session = sessionFor(client);
            session.suppressed++;
            publish(client, session);
            return;
          }
          message = `NOTIFICATION type ${d.typeValue}/${d.textByte}: ${text} (${packet.unreadData.length} bytes)`;
          break;
        }
        default: {
          // System senders may address a player; negative IDs alone also occur in private player traffic.
          if (typeof d.name !== 'string' || !(d.name === '' || d.name.startsWith('*') || (d.objectId < 0 && !d.recipient))) return;
          message = `TEXT ${d.name || '(system)'}${d.recipient ? ` → ${d.recipient}` : ''}: ${d.text}`;
        }
      }
      const session = sessionFor(client);
      session.lastMessage = sanitize(`[${client.clientId.slice(0, 8)}] ${message}`);
      ctx.log(session.lastMessage);
      session.messagesLogged++;
      publish(client, session);
    });
  }
  for (const name of ['MOVE', 'PLAYERSHOOT', 'USEITEM', 'PLAYERTEXT']) {
    ctx.observePacket(name, (client, packet) => {
      if (!ctx.enabled || packet.direction !== 'client' || !packet.isDefined) return;
      const session = sessionFor(client);
      const now = performance.now();
      if (name === 'MOVE') {
        const records: unknown = packet.data.records;
        if (!Array.isArray(records)) return;
        const last = records.at(-1);
        if (!last || !Number.isFinite(last.x) || !Number.isFinite(last.y)) return;
        const previous = session.position;
        session.position = { x: last.x, y: last.y };
        if (!previous || (previous.x === last.x && previous.y === last.y)) return;
        session.moved = now;
      } else if (name === 'PLAYERSHOOT') session.shot = now;
      else if (name === 'USEITEM') session.usedItem = now;
      else session.chatted = now;
    });
  }
}

export default definePlugin({
  id: 'server-messages', name: 'Server Messages', apiVersion: 1, capabilities: ['packets'], register,
});
