// Adapted from realm-engine-client client/plugins/anti-afk.ts @ 88a66b2 (MIT, see NOTICE).
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { InactivityDetector } from './detector.ts';
import { SETTING_DEFS, validate } from './settings.ts';

export function register(ctx: PluginContext): void {
  ctx.name = 'Anti-AFK'; ctx.category = 'utility'; ctx.enabled = false;
  const idle = new InactivityDetector();
  const skipLogged = new WeakMap<ClientConnection, Set<string>>();
  let disposed = false, pulses = 0;
  let lastPulse: { at: string; result: string } | null = null;
  let currentClient: ClientConnection | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPublishedIdleSeconds = 0;
  const idleSeconds = (client?: ClientConnection) => client?.connected
    ? Math.floor((idle.idleMs(client) ?? 0) / 1000) : 0;
  const publish = (client?: ClientConnection) => {
    lastPublishedIdleSeconds = idleSeconds(client);
    ctx.setData('status', { idleSeconds: lastPublishedIdleSeconds, pulses, lastPulse });
  };
  function cancelTimer(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }
  function scheduleStatus(): void {
    if (disposed || !ctx.enabled || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (disposed || !ctx.enabled) return;
      if (idleSeconds(currentClient) !== lastPublishedIdleSeconds) publish(currentClient);
      scheduleStatus();
    }, 1000);
  }
  for (const { key, ...def } of SETTING_DEFS) ctx.registerSetting(key, def);
  ctx.onEnabledChange(() => {
    if (disposed) return;
    idle.clear(); currentClient = undefined; cancelTimer(); publish(); scheduleStatus();
  });
  ctx.registerCleanup(() => { disposed = true; cancelTimer(); idle.clear(); currentClient = undefined; });
  ctx.on('clientConnected', client => { idle.reset(client); skipLogged.delete(client); currentClient = client; publish(); });
  ctx.on('clientDisconnected', client => {
    idle.reset(client);
    if (currentClient === client) currentClient = undefined;
    publish(currentClient);
  });
  for (const name of ['MAPINFO', 'RECONNECT']) ctx.observePacket(name, client => {
    if (disposed || !ctx.enabled || !client.connected) return;
    idle.reset(client); currentClient = client;
  });
  for (const name of ['PLAYERSHOOT', 'USEITEM', 'PLAYERTEXT', 'INVENTORYSWAP']) {
    ctx.observePacket(name, client => {
      if (disposed || !ctx.enabled || !client.connected) return;
      idle.active(client); currentClient = client;
    });
  }
  ctx.observePacket('MOVE', (client, packet) => {
    if (disposed || !ctx.enabled || !client.connected) return;
    const minutes = ctx.getSetting<number>('idleMinutes');
    const fire = idle.observeMove(client, packet.isDefined ? packet.data.records : undefined, minutes * 60_000);
    currentClient = client;
    if (!fire) return;
    void ctx.input.pulse(client).then(result => {
      if (disposed) return;
      lastPulse = { at: new Date().toISOString(), result: result.ok
        ? `sent${result.minimized ? ' (minimized)' : ''}` : `skipped: ${result.reason}` };
      if (result.ok) { pulses++; ctx.log(`Inactive for ${minutes} min; click sent.`); }
      else {
        const reasons = skipLogged.get(client) ?? new Set<string>();
        if (!reasons.has(result.reason)) {
          reasons.add(result.reason); skipLogged.set(client, reasons); ctx.log(`Pulse skipped: ${result.reason}.`);
        }
      }
      publish(client);
    });
  });
  publish();
}

export default definePlugin({ id: 'anti-afk', name: 'Anti-AFK', apiVersion: 1,
  capabilities: ['packets', 'input'], register, settings: { validate } });
