// Per-session delivery counters for the log. They show whether server data reached the game, what the
// server sent first, and which side went quiet, so a stalled or reset connection can be traced afterwards.

export interface HeldEntry {
  name: string;
  fromClient: boolean;
  ageMs: number;
}

interface Flow {
  frames: number;
  bytes: number;
}

const FIRST_SERVER_PACKETS = 8;
const MAX_HELD_LISTED = 5;

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function flow(f: Flow): string {
  return f.frames === 0 ? 'nothing' : `${f.frames} frames (${(f.bytes / 1024).toFixed(1)} KB)`;
}

export class SessionTrace {
  private readonly startedAt: number;
  private readonly fromGame: Flow = { frames: 0, bytes: 0 };
  private readonly toServer: Flow = { frames: 0, bytes: 0 };
  private readonly fromServer: Flow = { frames: 0, bytes: 0 };
  private readonly toGame: Flow = { frames: 0, bytes: 0 };
  private readonly firstServer: string[] = [];
  private written = 0;
  private droppedFromGame = 0;
  private droppedFromServer = 0;
  private lastGameAt: number | null = null;
  private lastServerAt: number | null = null;
  private helloSentAt: number | null = null;
  private firstServerAt: number | null = null;

  constructor(startedAt: number) {
    this.startedAt = startedAt;
  }

  /** A whole frame arrived from the game (fromClient) or the server. */
  received(fromClient: boolean, name: string, bytes: number, now: number): void {
    const f = fromClient ? this.fromGame : this.fromServer;
    f.frames++; f.bytes += bytes;
    if (fromClient) { this.lastGameAt = now; return; }
    this.lastServerAt = now;
    this.firstServerAt ??= now;
    if (this.firstServer.length < FIRST_SERVER_PACKETS) this.firstServer.push(name);
  }

  /** A frame was handed to a socket. `byRealmTool` marks frames RealmTool wrote itself. */
  sent(toClient: boolean, bytes: number, byRealmTool = false): void {
    const f = toClient ? this.toGame : this.toServer;
    f.frames++; f.bytes += bytes;
    if (byRealmTool) this.written++;
  }

  dropped(fromClient: boolean): void {
    if (fromClient) this.droppedFromGame++;
    else this.droppedFromServer++;
  }

  helloSent(now: number): void {
    this.helloSentAt = now;
  }

  /** `unsent` is what the sockets still buffer: data handed over but not yet taken by the peer. */
  summary(now: number, held: HeldEntry[], unsent: { game: number; server: number }): string {
    const parts = [`Session summary after ${seconds(now - this.startedAt)}`];
    parts.push(`game→proxy ${flow(this.fromGame)}${this.lastGameAt === null ? '' : `, last ${seconds(now - this.lastGameAt)} ago`}`);
    parts.push(`proxy→server ${flow(this.toServer)}`);
    let server = `server→proxy ${flow(this.fromServer)}`;
    if (this.firstServerAt !== null && this.helloSentAt !== null) {
      server += `, first ${Math.round(this.firstServerAt - this.helloSentAt)} ms after HELLO`;
    } else if (this.firstServerAt === null) {
      server += this.helloSentAt === null ? ' (HELLO never sent)' : ` (HELLO sent ${seconds(now - this.helloSentAt)} ago)`;
    }
    if (this.lastServerAt !== null) server += `, last ${seconds(now - this.lastServerAt)} ago`;
    parts.push(server);
    parts.push(`proxy→game ${flow(this.toGame)}${this.written ? `, ${this.written} written by RealmTool` : ''}`);
    parts.push(`dropped ${this.droppedFromGame} from game, ${this.droppedFromServer} from server`);
    if (held.length) {
      const listed = held.slice(0, MAX_HELD_LISTED)
        .map(h => `${h.name} from ${h.fromClient ? 'game' : 'server'} ${seconds(h.ageMs)}`).join(', ');
      parts.push(`held ${held.length} awaiting a plugin: ${listed}${held.length > MAX_HELD_LISTED ? ', …' : ''}`);
    }
    if (unsent.game) parts.push(`${(unsent.game / 1024).toFixed(1)} KB not yet taken by the game`);
    if (unsent.server) parts.push(`${(unsent.server / 1024).toFixed(1)} KB not yet taken by the server`);
    if (this.firstServer.length) parts.push(`first server packets: ${this.firstServer.join(', ')}`);
    return parts.join('; ');
  }
}
