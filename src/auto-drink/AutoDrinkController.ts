// Ported from realm-engine-client client/src/auto-drink/AutoDrinkController.ts @ 88a66b2 (MIT, see NOTICE).
import { SAFE_MAPS } from '../safety/safeMaps.ts';
import { ClientGameClock } from './ClientGameClock.ts';
import { autoDrinkCatalog, autoDrinkSettings, type AutoDrinkItem, type AutoDrinkSettings, type AutoDrinkStatus } from './AutoDrinkTypes.ts';

interface ObservedPacket { name: string; isDefined: boolean; data: Record<string, any> }
export interface AutoDrinkUse {
  time: number;
  slotObject: { objectId: number; slotId: number; objectType: number };
  itemUsePos: { x: number; y: number };
  useType: 0 | 1;
  unknownInt: 0;
}
export interface AutoDrinkBoundary {
  now(): number;
  wallNow(): number;
  /** Synchronous final socket acceptance, not a server acknowledgement. */
  send(use: AutoDrinkUse): boolean;
}
export interface AutoDrinkGate { available: boolean; backlog: boolean; escape: boolean }
interface Stock { type: number; qty: number; revision: number }
interface Reservation extends Stock { slotId: number; at: number; epoch: number; tainted: boolean }
const QUICK = 1_000_000;
const STALE_MS = 1500;
const PENDING_MS = 1500;
const BACKOFF_MS = 1000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const int32 = (v: unknown): v is number => finite(v) && Number.isInteger(v) && v >= 0 && v <= 0x7fffffff;

/** Worker-owned, timer/socket-free consumer. It never predicts HP or edits SafetyEngine state. */
export class AutoDrinkController {
  private settings = autoDrinkSettings();
  private catalog = new Map<number, AutoDrinkItem>();
  private epoch = 0;
  private map = '';
  private owner = 0;
  private hp: number | null = null;
  private maxHp: number | null = null;
  private mp: number | null = null;
  private maxMp: number | null = null;
  private effects: [number | null, number | null] = [null, null];
  private position: { x: number; y: number } | null = null;
  private backpack = 0;
  private legacyBackpack = false;
  private stock = new Map<number, Stock>();
  // Retain the last valid baseline through malformed snapshots: unknown -> same
  // stock is not an ACK, but a later genuine change must still release a wait.
  private unknownStock = new Set<number>();
  private revision = 0;
  private pending: Reservation | null = null;
  // A timed-out/ambiguous operation cannot be retried against the same stock.
  private waiting = new Map<number, number>();
  private lastTick = -1;
  private lastServerAt: number | null = null;
  private readonly clientClock = new ClientGameClock();
  private lastUseAt: number | null = null;
  private nextUseAt = 0;
  private lastUseTime: number | null = null;
  private nextUseTime = 0;
  private backoffUntil = 0;
  private hotUntil = 0;
  private escaped = false;
  private terminal = '';
  private state = 'disabled';
  private reason = 'disabled';
  private lastAttemptAt: number | null = null;
  private lastSlot: number | null = null;
  private lastItem: number | null = null;

  private readonly boundary: AutoDrinkBoundary;

  constructor(boundary: AutoDrinkBoundary) { this.boundary = boundary; }

  configure(settings: Partial<AutoDrinkSettings>): void {
    this.settings = autoDrinkSettings({ ...this.settings, ...settings });
    // A shorter interval, toggle, catalog reload or MAPINFO cannot move a deadline backwards.
    if (this.lastUseAt !== null) this.nextUseAt = Math.max(this.nextUseAt, this.lastUseAt + this.settings.intervalMs);
    if (this.lastUseTime !== null) this.nextUseTime = Math.max(this.nextUseTime, this.lastUseTime + this.settings.intervalMs);
    this.setState(this.settings.enabled ? 'waiting' : 'disabled', this.settings.enabled ? 'awaiting authoritative state' : 'disabled');
  }
  setCatalog(items: AutoDrinkItem[]): void { this.catalog = new Map(autoDrinkCatalog(items).map(i => [i.type, i])); }

  connectionChanged(): void {
    this.escaped = false; this.terminal = ''; this.clientClock.reset(true);
    this.lastUseAt = null; this.nextUseAt = this.backoffUntil = this.hotUntil = 0;
    this.lastUseTime = null; this.nextUseTime = 0;
    this.lastAttemptAt = null; this.lastSlot = this.lastItem = null;
    this.reset('');
  }
  escape(): void { this.escaped = true; this.setState('blocked', 'escape lifecycle'); }
  disconnect(): void { this.terminal = 'disconnected'; this.pending = null; this.clientClock.reset(); this.setState('blocked', this.terminal); }

  private reset(map: string): void {
    ++this.epoch; this.map = map; this.owner = 0;
    this.hp = this.maxHp = this.mp = this.maxMp = null;
    this.effects = [null, null]; this.position = null; this.backpack = 0; this.legacyBackpack = false;
    this.stock.clear(); this.unknownStock.clear(); this.waiting.clear(); this.pending = null;
    this.lastServerAt = null; this.lastTick = -1;
    this.clientClock.reset();
    this.setState('waiting', 'loading');
  }

  /** Only ORIGINAL server packets reach this method. Rewrites/injections are never health evidence. */
  observeServer(packet: ObservedPacket): void {
    const now = this.boundary.now(), d = packet.data;
    if (!finite(now) || now < 0) { this.lastServerAt = null; return; }
    if (packet.name === 'MAPINFO') { this.reset(packet.isDefined && typeof d.name === 'string' ? d.name : ''); return; }
    if (packet.name === 'CREATESUCCESS') {
      this.reset(this.map);
      if (packet.isDefined && int32(d.objectId)) this.owner = d.objectId;
      return;
    }
    if (packet.name === 'DEATH' || (packet.isDefined && packet.name === 'DAMAGE' && d.kill === true && this.owner > 0 && d.targetId === this.owner)) {
      this.terminal = 'dead'; this.pending = null; return;
    }
    if (packet.name === 'RECONNECT') { this.escape(); return; }
    if (!['UPDATE', 'NEWTICK'].includes(packet.name)) return;
    if (!packet.isDefined) { this.lastServerAt = null; return; }
    if (packet.name === 'NEWTICK') {
      if (!int32(d.tickId) || d.tickId <= this.lastTick) return;
      this.lastTick = d.tickId;
      this.lastServerAt = now;
      for (const status of d.statuses ?? []) this.applyStatus(status, false);
    } else {
      for (const entity of d.newObjs ?? []) this.applyStatus(entity.status, true);
      if ((d.drops ?? []).includes(this.owner)) { this.owner = 0; this.lastServerAt = null; }
    }
  }

  private applyStatus(status: any, full: boolean): void {
    if (!status || !this.owner || status.objectId !== this.owner || !Array.isArray(status.data)) return;
    this.lastServerAt = this.boundary.now();
    if (full) { this.effects[0] ??= 0; this.effects[1] ??= 0; }
    this.position = finite(status.position?.x) && finite(status.position?.y)
      ? { x: status.position.x, y: status.position.y } : null;
    for (const stat of status.data) {
      if (!stat) continue;
      const slotId = stat.id >= 116 && stat.id <= 118 ? QUICK + stat.id - 116
        : stat.id >= 12 && stat.id <= 19 ? stat.id - 8
        : stat.id >= 131 && stat.id <= 146 ? stat.id - 131 + 12 : null;
      if (!finite(stat.value)) {
        if (stat.id === 0) this.maxHp = null;
        if (stat.id === 1) this.hp = null;
        if (stat.id === 3) this.maxMp = null;
        if (stat.id === 4) this.mp = null;
        if (stat.id === 29) this.effects[0] = null;
        if (stat.id === 95) this.effects[1] = null;
        if (stat.id === 75) this.legacyBackpack = false;
        if (stat.id === 130) this.backpack = 0;
        if (slotId !== null) this.invalidateStock(slotId);
        continue;
      }
      const v = stat.value;
      // Stat 0/3 are the authoritative maxima. Boost/exalt stats are NOT added.
      if (stat.id === 0) this.maxHp = v > 0 ? v : null;
      if (stat.id === 1) this.hp = v >= 0 ? v : null;
      if (stat.id === 3) this.maxMp = v > 0 ? v : null;
      if (stat.id === 4) this.mp = v >= 0 ? v : null;
      if (stat.id === 29) {
        if (Number.isInteger(v) && (v & (1 << 20))) this.clientClock.reset();
        this.effects[0] = Number.isInteger(v) ? v : null;
      }
      if (stat.id === 95) this.effects[1] = Number.isInteger(v) ? v : null;
      if (stat.id === 75) this.legacyBackpack = v !== 0;
      if (stat.id === 130) this.backpack = v;
      if (slotId !== null) {
        const qty = slotId >= QUICK ? stat.stackCount : v < 0 ? 0 : 1;
        if ((v === -1 || int32(v)) && int32(qty)) this.observeStock(slotId, v, qty);
        else this.invalidateStock(slotId);
      }
    }
  }

  private invalidateStock(slotId: number): void {
    this.unknownStock.add(slotId);
    if (this.pending?.slotId === slotId) this.pending.tainted = true;
  }

  private observeStock(slotId: number, type: number, qty: number): void {
    const previous = this.stock.get(slotId);
    this.unknownStock.delete(slotId);
    if (previous?.type === type && previous.qty === qty) return; // repeated snapshots are not ACKs
    const next = { type, qty, revision: ++this.revision };
    this.stock.set(slotId, next);
    const waitingRevision = this.waiting.get(slotId);
    if (waitingRevision !== undefined && next.revision > waitingRevision) this.waiting.delete(slotId);
    const p = this.pending;
    if (!p || p.slotId !== slotId || p.epoch !== this.epoch) return;
    if (!p.tainted && previous?.revision === p.revision && qty < p.qty && (type === p.type || (type === -1 && qty === 0))) {
      this.pending = null; // stock confirmed once; absolutely no HP/healing credit
    } else p.tainted = true; // restock/type replacement cannot acknowledge consumption
  }

  /** Narrow arbitration: only injected swaps touching the outstanding automatic slot are refused. */
  blocksInjectedSwap(packet: ObservedPacket): boolean {
    return !!this.pending && packet.isDefined && packet.name === 'INVENTORYSWAP'
      && this.affectedSlots(packet).includes(this.pending.slotId);
  }
  private affectedSlots(packet: ObservedPacket): number[] {
    const d = packet.data;
    const slots = packet.name === 'INVENTORYSWAP' ? [d.slotObject1, d.slotObject2] : [d.slotObject];
    return slots.filter(s => this.owner > 0 && s?.objectId === this.owner && int32(s.slotId)
      && ((s.slotId >= 4 && s.slotId <= 27) || (s.slotId >= QUICK && s.slotId < QUICK + 3))).map(s => s.slotId);
  }

  /** Called ONLY after accepted final writes, for both forwarded and injected input. */
  observeOutgoing(packet: ObservedPacket): void {
    if (!packet.isDefined) return;
    const now = this.boundary.now(), d = packet.data;
    if (packet.name === 'ESCAPE') { this.escape(); return; }
    if (!finite(now) || now < 0) return;
    if (['MOVE', 'PONG', 'PLAYERSHOOT'].includes(packet.name)) {
      const time = packet.name === 'MOVE' ? (Array.isArray(d.records) ? d.records.at(-1)?.time : undefined) : d.time;
      if (!(this.effects[0]! & (1 << 20))) this.clientClock.observe(time, now);
    }
    if (!['USEITEM', 'INVENTORYSWAP', 'INVDROP'].includes(packet.name)) return;
    const slots = this.affectedSlots(packet);
    if (packet.name === 'USEITEM') {
      const item = this.catalog.get(d.slotObject?.objectType);
      // Equipment USEITEM (especially auto-ability slot 1) is not consumption.
      // Unknown quickslot consumables still share the limiter; inventory items
      // require catalog evidence that they restore HP/MP or apply Healing.
      if (slots.some(s => (s >= QUICK && s < QUICK + 3) || (s >= 4 && s <= 27 && !!item))) {
        this.lastUseAt = now; this.nextUseAt = Math.max(this.nextUseAt, now + this.settings.intervalMs);
        if (int32(d.time)) {
          this.lastUseTime = Math.max(this.lastUseTime ?? 0, d.time);
          this.nextUseTime = Math.max(this.nextUseTime, this.lastUseTime + this.settings.intervalMs);
        }
        if (item) this.hotUntil = Math.max(this.hotUntil, now + item.healingDurationMs);
      }
    }
    for (const slotId of slots) {
      this.waiting.set(slotId, this.stock.get(slotId)?.revision ?? this.revision);
      if (this.pending?.slotId === slotId) this.pending.tainted = true;
    }
  }

  evaluate(gate: AutoDrinkGate): void {
    const now = this.boundary.now();
    if (!finite(now) || now < 0) { this.setState('blocked', 'invalid monotonic clock'); return; }
    if (this.pending && now - this.pending.at >= PENDING_MS) {
      this.waiting.set(this.pending.slotId, this.stock.get(this.pending.slotId)?.revision ?? this.revision);
      this.pending = null; this.backoffUntil = now + BACKOFF_MS;
    }
    const time = this.clientClock.time(now);
    const block = this.blockReason(gate, now, time);
    if (block) { this.setState(this.settings.enabled ? 'blocked' : 'disabled', block); return; }
    if (this.pending) { this.setState('pending', 'awaiting stock decrease'); return; }
    if (now < Math.max(this.nextUseAt, this.backoffUntil)) { this.setState('cooldown', 'shared consume cooldown'); return; }
    if (time! < this.nextUseTime) { this.setState('cooldown', 'shared consume protocol cooldown'); return; }
    const hpNeeded = this.settings.enableHp && this.settings.hpThresholdPct > 0 && this.hp! <= this.maxHp! * this.settings.hpThresholdPct / 100;
    const mpNeeded = this.settings.enableMp && this.settings.mpThresholdPct > 0 && this.mp !== null && this.maxMp !== null
      && this.mp <= this.maxMp * this.settings.mpThresholdPct / 100;
    if (!hpNeeded && !mpNeeded) { this.setState('ready', 'above thresholds'); return; }
    const slots = this.settings.slotPriority.map(i => QUICK + i);
    if (this.settings.inventoryFallback) {
      for (let i = 4; i < 12; ++i) slots.push(i);
      const count = this.backpack >= 16 ? 16 : this.backpack >= 8 || this.legacyBackpack ? 8 : 0;
      for (let i = 0; i < count; ++i) slots.push(12 + i);
    }
    for (const resource of [...(hpNeeded ? ['hp' as const] : []), ...(mpNeeded ? ['mp' as const] : [])]) {
      for (const slotId of slots) {
        const stock = this.stock.get(slotId), item = stock && this.catalog.get(stock.type);
        if (!stock || this.unknownStock.has(slotId) || stock.qty <= 0 || !item
          || (item[resource] <= 0 && !(resource === 'hp' && item.healingDurationMs > 0)) || this.waiting.has(slotId)
          || this.settings.excludedItems.includes(item.type) || (slotId >= QUICK && !item.quickslot)) continue;
        if (item.healingDurationMs > 0 && (!this.settings.healingOverTime || now < this.hotUntil || (this.effects[0]! & (1 << 17)))) continue;
        const use: AutoDrinkUse = { time: time!, slotObject: { objectId: this.owner, slotId, objectType: item.type },
          itemUsePos: { ...this.position! }, useType: slotId >= QUICK ? 0 : 1, unknownInt: 0 };
        // Reserve before invoking the synchronous writer. No asynchronous proposal can race a map/escape.
        this.pending = { ...stock, slotId, at: now, epoch: this.epoch, tainted: false };
        this.lastAttemptAt = this.boundary.wallNow(); this.lastSlot = slotId; this.lastItem = item.type;
        if (!this.boundary.send(use)) {
          this.pending = null; this.waiting.set(slotId, stock.revision); this.backoffUntil = now + BACKOFF_MS;
          this.setState('blocked', 'write rejected'); return;
        }
        // Anchor the deadline AFTER synchronous socket acceptance, never at an
        // earlier evaluation/timer timestamp (serialization itself takes time).
        const acceptedAt = this.boundary.now();
        this.lastUseAt = finite(acceptedAt) ? Math.max(now, acceptedAt) : now;
        this.nextUseAt = this.lastUseAt + this.settings.intervalMs;
        this.lastUseTime = time; this.nextUseTime = time! + this.settings.intervalMs;
        this.pending.at = this.lastUseAt;
        this.hotUntil = Math.max(this.hotUntil, this.lastUseAt + item.healingDurationMs);
        this.setState('pending', 'awaiting stock decrease'); return;
      }
    }
    this.setState('waiting', this.waiting.size ? 'awaiting fresh stock' : 'no eligible stock');
  }

  private blockReason(gate: AutoDrinkGate, now: number, time: number | null): string {
    if (!this.settings.enabled) return 'disabled';
    if (this.escaped || gate.escape) return 'escape lifecycle';
    if (this.terminal) return this.terminal;
    if (!gate.available) return 'transport unavailable';
    if (gate.backlog) return 'packet backlog';
    if (!this.map.trim() || !this.owner) return 'loading';
    if (SAFE_MAPS.has(this.map.trim().toLowerCase())) return 'safe map';
    if (this.hp === null || this.maxHp === null || !this.position || this.effects.some(v => v === null)) return 'unknown player state';
    if (this.hp <= 0 || (this.effects[0]! & 1)) return 'dead';
    if (this.effects[0]! & (1 << 20)) return 'paused';
    if (this.effects[0]! & (1 << 4)) return 'sick';
    // MultiTool decompilation confirms second-mask 0x20000000 = Drought.
    // Live target-build validation is still pending; do not use the old index-31 guess.
    if (this.effects[1]! & 0x20000000) return 'drought';
    if (this.lastServerAt === null || now < this.lastServerAt || now - this.lastServerAt > STALE_MS) return 'stale server stream';
    if (time === null) return 'client clock unavailable';
    return '';
  }
  private setState(state: string, reason: string): void { this.state = state; this.reason = reason; }
  status(): AutoDrinkStatus {
    const now = this.boundary.now();
    const time = this.clientClock.time(now);
    return { enabled: this.settings.enabled, state: this.settings.enabled ? this.state : 'disabled',
      reason: this.settings.enabled ? this.reason : 'disabled', hp: this.hp, maxHp: this.maxHp,
      slotId: this.pending?.slotId ?? this.lastSlot, itemType: this.pending?.type ?? this.lastItem,
      lastAttemptAt: this.lastAttemptAt, cooldownRemainingMs: finite(now)
        ? Math.max(0, Math.ceil(Math.max(this.nextUseAt, this.backoffUntil) - now), time === null ? 0 : this.nextUseTime - time) : 0,
      pending: this.pending !== null, epoch: this.epoch };
  }
}
