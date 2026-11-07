// Adapted from realm-engine-client client/src/safety/SafetyEngine.ts @ 88a66b2 (MIT, see NOTICE).
import type { Packet } from '../protocol/Packet.ts';
import { ServerPlayerState } from './ServerPlayerState.ts';
import { EscapeAttemptCoordinator, type EscapeTransport } from './EscapeAttemptCoordinator.ts';
import { HealthPredictor } from './HealthPredictor.ts';
import { assessPredictedLoss, applyProjectileConditions, withProjectileConditions, type PlayerDamageBasis } from './DamageModel.ts';
import type { SafetyCatalog, SafetyProjectileDef } from './SafetyCatalog.ts';
import { SAFE_MAPS } from './safeMaps.ts';
import {
  DEFAULT_SAFETY_SETTINGS, safetySettings,
  type SafetySettingsInput, type SafetyDecision, type SafetyStatus, type EscapePhase,
  type SafetyDecisionEvidence, type ProtectionState, type EscapeWriteReceipt,
} from './SafetyTypes.ts';

export const SERVER_HP_STALE_MS = 3000;

interface Shot {
  id: string; at: number; expires: number; raw: number; def?: SafetyProjectileDef; ambiguous: boolean;
  owner: number; ownerType?: number; bulletType: number;
}
interface AreaAttack { id: string; observationId: number | null; x: number; y: number; radius: number; raw: number; at: number }
const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const pair = (owner: number, bullet: number) => `${owner}:${bullet & 0xffff}`;

/** Single-owner, timer-free state machine. All times are monotonic milliseconds. */
export class SafetyEngine {
  settings = { ...DEFAULT_SAFETY_SETTINGS };
  readonly predictor = new HealthPredictor();
  private damageBasisRevision = 0;
  private damageBasisAt: number | null = null;
  private projectileConditions = new Map<string, number>();
  private seq = 0;
  private shots = new Map<string, Shot>();
  private types = new Map<number, number>();
  private definitions = new Map<string, SafetyProjectileDef>();
  private tileDamage = new Map<number, number>();
  private tiles = new Map<string, number>();
  private aoeSeq = 0;
  private areas: AreaAttack[] = [];
  private lastCleanup = 0;
  private predictionObservation = 0;
  private predictionOccurrences = new Map<string, number>();
  private predictionSignatures = new Map<number, string>();
  private unresolvedSerial = 0;
  private unresolvedOccurrences = new Map<string, { count: number; expires: number; id: string }>();
  readonly attempts: EscapeAttemptCoordinator;
  player = new ServerPlayerState();
  epoch = 0;
  private terminal: 'dead' | 'transition' | null = null;
  map = '';
  private safe = false;
  private mapUnreadable = false;
  private hpStreamUnreadable = false;
  private streamStartedAt = 0;
  private lastServerAt: number | null = null;
  private lastHpAt: number | null = null;
  // An HP-less delta proves HP unchanged only while every server HP carrier since the anchor was read.
  private hpAnchorContinuous = false;
  private lastHp: number | null = null;
  private lastTick = -1;
  private lastReason = '';
  private latestNow = 0;
  private readonly escape: (decision: SafetyDecision, accepted: boolean) => void;

  constructor(escape: (decision: SafetyDecision, accepted: boolean) => void, transport?: EscapeTransport,
    observeWrite?: (receipt: EscapeWriteReceipt) => void) {
    this.escape = escape;
    this.attempts = new EscapeAttemptCoordinator(transport, observeWrite);
  }

  configure(settings: SafetySettingsInput, now: number): void {
    const normalized = safetySettings({ ...this.settings, ...settings });
    this.latestNow = now;
    const wasEnabled = this.settings.enabled;
    const modeChanged = this.settings.preHitPrediction !== normalized.preHitPrediction;
    this.settings = normalized;
    if (modeChanged) {
      // Retiring estimates is not a new HP sample or escape lifecycle.
      this.predictor.clearDebt(); this.areas = [];
      this.predictionOccurrences.clear(); this.predictionSignatures.clear();
      this.unresolvedOccurrences.clear(); this.projectileConditions.clear();
    }
    if (wasEnabled !== this.settings.enabled) this.attempts.cancel(now);
    // Toggling is not healing, a new connection, or a transition acknowledgement.
    this.check(now, 'settings changed');
  }

  setCatalog(catalog: SafetyCatalog): void {
    this.definitions = new Map(catalog.projectiles.map(([type, bullet, def]) => [`${type}:${bullet}`, def]));
    this.tileDamage = new Map(catalog.tiles);
  }

  reset(map = this.map, mapUnreadable = this.mapUnreadable): void {
    this.attempts.reset(++this.epoch); // Invalidate ownership BEFORE processing map/state.
    this.map = typeof map === 'string' ? map : '';
    this.safe = !!this.map.trim() && SAFE_MAPS.has(this.map.trim().toLowerCase());
    this.mapUnreadable = mapUnreadable;
    this.hpStreamUnreadable = false; this.streamStartedAt = this.latestNow;
    this.player = new ServerPlayerState(); this.predictor.reset();
    this.predictionOccurrences.clear(); this.predictionSignatures.clear(); this.unresolvedOccurrences.clear();
    this.unresolvedSerial = 0; this.damageBasisRevision = 0; this.damageBasisAt = null;
    this.projectileConditions.clear(); this.shots.clear(); this.types.clear(); this.tiles.clear(); this.areas = [];
    this.lastHp = null; this.lastHpAt = null; this.lastServerAt = null; this.hpAnchorContinuous = false;
    this.lastTick = -1; this.lastReason = '';
  }

  connectionChanged(generation: number): void {
    this.attempts.replaceConnection(generation); this.terminal = null; this.reset('', false);
  }
  confirmTransition(now: number): void {
    if (this.terminal === 'dead') return;
    this.terminal = 'transition'; this.attempts.cancel(now);
  }
  died(now: number): void { this.terminal = 'dead'; this.attempts.cancel(now); }

  observe(packet: Packet, now: number, observationId: number | null = null): void {
    this.latestNow = now;
    const fromClient = packet.direction === 'client';
    // Even unreadable map/character packets retire the old lifecycle.
    if (!fromClient && packet.name === 'MAPINFO') {
      this.reset(packet.isDefined ? packet.data.name ?? '' : '',
        !packet.isDefined || typeof packet.data.name !== 'string' || !packet.data.name.trim()); return;
    }
    if (!fromClient && packet.name === 'CREATESUCCESS') {
      this.reset();
      if (packet.isDefined) this.player.ownerObjectId = Number(packet.data.objectId) || 0;
      return;
    }
    if (!fromClient && packet.name === 'DEATH') {
      this.died(now);
      this.lastReason = `death: ${String(packet.isDefined ? packet.data.killedBy ?? 'unknown' : 'unknown').replace(/[\r\n]/g, ' ').slice(0, 120)}`;
      return;
    }
    if (!packet.isDefined) {
      if (!fromClient && ['NEWTICK', 'UPDATE'].includes(packet.name)) {
        this.hpAnchorContinuous = false; this.hpStreamUnreadable = true;
      }
      if (!fromClient && ['NEWTICK', 'UPDATE', 'DAMAGE'].includes(packet.name)) this.uncertain(now, `unreadable ${packet.name}`);
      return;
    }
    if (fromClient) {
      if (this.settings.preHitPrediction) this.predictionReport(packet, now, observationId);
      return;
    }
    const d = packet.data;
    // The worker adapter must withhold RECONNECT until its validated final write.
    if (packet.name === 'RECONNECT') { this.confirmTransition(now); return; }
    if (packet.name === 'UPDATE') {
      for (const tile of d.tiles ?? []) this.tiles.set(`${tile.x},${tile.y}`, tile.type);
      for (const entity of d.newObjs ?? []) {
        if (!entity.status) continue;
        this.types.set(entity.status.objectId, entity.objectType);
        if (this.player.ownerObjectId !== 0 && entity.status.objectId === this.player.ownerObjectId) {
          this.lastServerAt = now;
        }
        this.applyStatus(entity.status, now, true);
      }
      for (const id of d.drops ?? []) this.types.delete(id);
    }
    if (packet.name === 'NEWTICK') {
      if (!Number.isInteger(d.tickId) || d.tickId <= this.lastTick) return;
      this.lastTick = d.tickId; this.lastServerAt = now;
      this.predictor.timing(now, d.serverLastRttMs);
      const hasOwnerHp = (d.statuses ?? []).some((status: Parameters<ServerPlayerState['applyStatus']>[0]) =>
        status.objectId === this.player.ownerObjectId && Array.isArray(status.data) && status.data.some(s => s?.id === 1));
      // Invalid explicit HP is not evidence of unchanged HP, and it breaks the anchor until a valid sample.
      if (this.settings.preHitPrediction && this.hpAnchorContinuous && !hasOwnerHp) this.predictor.unchangedHp(now);
      for (const status of d.statuses ?? []) this.applyStatus(status, now);
      this.check(now, 'server tick');
    }
    if (packet.name === 'ENEMYSHOOT') this.shot(d, now);
    if (packet.name === 'DAMAGE' && d.targetId === this.player.ownerObjectId && this.player.ownerObjectId !== 0) {
      if (d.kill === true) { this.lastHp = this.player.hp = 0; this.predictor.snapshot(0, now); this.died(now); return; }
      if (this.settings.preHitPrediction && finite(d.damageAmount) && d.damageAmount >= 0) {
        const shot = this.shots.get(pair(d.objectId, d.bulletId));
        if (shot && !shot.ambiguous && shot.expires >= now && !this.definitionFor(shot)?.multiHit) {
          this.predictor.impact(shot.id, { amount: d.damageAmount, kind: 'measured', reason: 'server DAMAGE' }, now,
            'server-damage', shot.expires, null, true);
        } else if (!shot || !this.definitionFor(shot)?.multiHit) {
          const occurrence = this.unresolved(d.objectId, d.bulletId, now);
          if (occurrence && occurrence.count <= 1)
            this.predictor.impact(occurrence.id, { amount: d.damageAmount, kind: 'measured', reason: 'server DAMAGE; unresolved spawn' }, now,
              'server-damage', now + 12000, null, true);
          else this.predictor.noteCoverage('ambiguous DAMAGE occurrence; reported assumptions retained');
        } else this.predictor.noteCoverage('multi-hit DAMAGE occurrence unverified; reported occurrences retained');
        this.check(now, 'server damage');
      }
    }
    if (packet.name === 'AOE') {
      if (!this.settings.preHitPrediction) return;
      const p = d.position;
      if (!p || ![p.x, p.y, d.radius, d.damage].every(finite) || d.radius < 0 || d.damage < 0) {
        this.uncertain(now, 'invalid AoE geometry/damage'); return;
      }
      if (this.areas.length >= 128) { this.uncertain(now, 'AoE correspondence capacity'); return; }
      const area = { id: `aoe:${++this.aoeSeq}`, observationId, x: p.x, y: p.y, radius: d.radius, raw: d.damage, at: now };
      this.areas.push(area);
    }
  }


  retireArea(observationId: number): void {
    const index = this.areas.findIndex(area => area.observationId === observationId);
    if (index !== -1) this.areas.splice(index, 1);
  }

  private applyStatus(status: Parameters<ServerPlayerState['applyStatus']>[0], now: number, full = false): void {
    if (this.player.ownerObjectId === 0 || status.objectId !== this.player.ownerObjectId) return;
    const incoming = Array.isArray(status.data) ? status.data : [];
    if (full || incoming.some(s => [21, 29, 95].includes(s?.id))) {
      ++this.damageBasisRevision; this.damageBasisAt = now;
    }
    const hp = this.player.applyStatus(status, full);
    if (incoming.some(s => s?.id === 1)) this.hpAnchorContinuous = hp !== null;
    if (hp !== null) {
      // After a decode gap, an HP-less delta cannot prove the old HP still holds.
      this.hpStreamUnreadable = false;
      this.lastHp = hp; this.lastHpAt = now; this.lastServerAt = now;
      this.predictor.snapshot(hp, now);
    }
    this.check(now, 'server health');
  }

  private shot(d: Record<string, any>, now: number): void {
    if (!Number.isInteger(d.ownerId) || !Number.isInteger(d.bulletId)) return;
    const type = this.types.get(d.ownerId);
    const def = this.definitions.get(`${type}:${d.bulletType}`);
    const count = !Number.isInteger(d.numShots) || d.numShots <= 0 || d.numShots === 255 ? 1 : Math.min(255, d.numShots);
    for (let i = 0; i < count; ++i) {
      const key = pair(d.ownerId, d.bulletId + i);
      const old = this.shots.get(key);
      if (this.shots.size >= 8192 && !old) { this.uncertain(now, 'projectile tracker capacity'); return; }
      this.shots.set(key, { id: `${this.epoch}:${key}:${++this.seq}`, at: now,
        expires: now + (def?.lifetimeMs || 10000) + 2000, raw: d.damage, def,
        ambiguous: !!old && old.expires > now, owner: d.ownerId, ownerType: type, bulletType: d.bulletType });
    }
  }

  private definitionFor(shot: Shot): SafetyProjectileDef | undefined {
    shot.ownerType ??= this.types.get(shot.owner);
    // Re-resolve against the CURRENT catalog. Missing metadata at spawn time
    // must not permanently poison a shot after extraction/reload or owner UPDATE.
    shot.def = this.definitions.get(`${shot.ownerType}:${shot.bulletType}`);
    return shot.def;
  }

  private reportSignature(packet: Packet): string {
    const d = packet.data;
    return `${packet.name}:${d.objectId}:${d.bulletId}:${d.position?.x}:${d.position?.y}`;
  }

  /** Final-writer assessment for a prepared client report. Returns the delivery id to pass to
   * reportDelivered: the observation id, or a synthetic negative id when there was none. */
  preparePredictionWrite(packet: Packet, now: number, observationId: number | null): number | null {
    this.latestNow = now;
    if (!this.settings.preHitPrediction || !packet.isDefined || packet.direction !== 'client'
      || !['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE'].includes(packet.name)) return observationId;
    const id = observationId ?? --this.predictionObservation;
    if (this.predictionSignatures.get(id) !== this.reportSignature(packet)) this.predictionReport(packet, now, id);
    return id;
  }
  reportDelivered(observationId: number | null, now: number, written: boolean): void {
    this.predictor.delivered(observationId, now, written ? 'written' : 'blocked');
    if (observationId !== null) this.predictionSignatures.delete(observationId);
  }
  private predictionReport(packet: Packet, now: number, observationId: number | null): void {
    const d = packet.data;
    if (!['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE'].includes(packet.name)) return;
    if (observationId !== null) {
      if (this.predictionSignatures.size >= HealthPredictor.CAPACITY && !this.predictionSignatures.has(observationId)) {
        this.predictor.fault = 'HP prediction report capacity'; this.check(now, 'report capacity'); return;
      }
      this.predictionSignatures.set(observationId, this.reportSignature(packet));
    }
    if (packet.name === 'PLAYERHIT') {
      const validIdentity = Number.isInteger(d.objectId) && Number.isInteger(d.bulletId);
      const shot = validIdentity ? this.shots.get(pair(d.objectId, d.bulletId)) : undefined;
      const identityReason = !shot ? 'missing-shot' : shot.ambiguous ? 'ambiguous-shot' : shot.expires < now ? 'expired-shot' : null;
      const definition = shot ? this.definitionFor(shot) : undefined;
      let id = !identityReason && shot ? shot.id : validIdentity
        ? `unresolved:${this.epoch}:${pair(d.objectId, d.bulletId)}` : `unidentified:${++this.seq}`;
      if (identityReason && validIdentity) {
        // Every unresolved contact is distinct. The serial never restarts when
        // a correspondence window expires while an older loss remains active.
        const occurrence = this.unresolved(d.objectId, d.bulletId, now);
        if (!occurrence) { this.check(now, 'identity capacity'); return; }
        // Only a report extends correspondence; a DAMAGE lookup must not.
        occurrence.expires = now + 12000;
        ++occurrence.count;
        id = occurrence.count === 1 ? occurrence.id : `${id}:occurrence:${++this.unresolvedSerial}`;
      }
      if (shot && !identityReason && definition?.multiHit) {
        const occurrence = (this.predictionOccurrences.get(shot.id) ?? 0) + 1;
        this.predictionOccurrences.set(shot.id, occurrence);
        id = `${shot.id}:occurrence:${occurrence}`;
      }
      const alreadyReported = this.predictor.has(id);
      this.predictor.impact(id, assessPredictedLoss(shot?.raw, definition, this.damageBasis(now), identityReason),
        now, 'player-hit', shot?.expires ?? now + 12000, observationId);
      if (!alreadyReported && !identityReason) applyProjectileConditions(this.projectileConditions, definition, now);
    } else if (packet.name === 'GROUNDDAMAGE') {
      const pos = d.position;
      const type = pos && finite(pos.x) && finite(pos.y) ? this.tiles.get(`${Math.floor(pos.x)},${Math.floor(pos.y)}`) : undefined;
      const evidence = { tileDamage: type === undefined ? null : this.tileDamage.get(type) ?? null };
      const known = finite(evidence.tileDamage) && evidence.tileDamage >= 0 && this.player.conditionsKnown && !(this.player.effects2 & (1 << 6));
      this.predictor.impact(`ground:${++this.seq}`, { amount: known ? evidence.tileDamage! : Math.max(200, evidence.tileDamage ?? 0),
        kind: known ? 'mitigated-estimate' : 'assumed', reason: known ? 'raw tile damage estimate' : 'unresolved ground mechanics' }, now, 'ground', now + 12000, observationId);
    } else {
      const area = this.areas[0];
      this.areas.shift();
      const known = area && now - area.at <= Math.max(1000, 2 * this.settings.reactionMs)
        && this.player.conditionsKnown && !(this.player.effects2 & (1 << 6));
      const pos = d.position;
      const misses = known && pos && finite(pos.x) && finite(pos.y)
        && Math.hypot(pos.x - area.x, pos.y - area.y) > area.radius + .5;
      if (!misses) this.predictor.impact(area?.id ?? `aoe-unresolved:${++this.seq}`,
        { amount: known ? area.raw : Math.max(200, area?.raw ?? 0), kind: known ? 'mitigated-estimate' : 'assumed',
          reason: known ? 'raw AoE damage estimate' : 'unresolved AoE mechanics' }, now, 'aoe', now + 12000, observationId);
    }
    this.check(now, 'reported impact');
  }

  private damageBasis(now: number, active: ReadonlyMap<string, number> = this.projectileConditions): PlayerDamageBasis {
    return withProjectileConditions({ defense: this.player.defense,
      effects: this.player.effects, effects2: this.player.effects2, conditionsKnown: this.player.conditionsKnown,
      revision: this.damageBasisRevision, ageMs: this.damageBasisAt === null ? null : now - this.damageBasisAt }, active, now);
  }

  private unresolved(owner: number, bullet: number, now: number) {
    const key = `unresolved:${this.epoch}:${pair(owner, bullet)}`;
    const prior = this.unresolvedOccurrences.get(key);
    if (prior && prior.expires >= now) return prior;
    if (!prior && this.unresolvedOccurrences.size >= HealthPredictor.CAPACITY) {
      this.predictor.fault = 'HP prediction unresolved identity capacity'; return null;
    }
    const occurrence = { count: 0, expires: now + 12000, id: `${key}:occurrence:${++this.unresolvedSerial}` };
    this.unresolvedOccurrences.set(key, occurrence);
    return occurrence;
  }

  deliveryBacklog(value: boolean): void { this.predictor.deliveryBacklog(value); }

  advance(now: number): void {
    this.latestNow = now;
    this.predictor.expire(now);
    if (now - this.lastCleanup >= 1000) {
      this.lastCleanup = now;
      this.areas = this.areas.filter(area => now - area.at <= 10000);
      for (const [id, occurrence] of this.unresolvedOccurrences) if (occurrence.expires < now) this.unresolvedOccurrences.delete(id);
      for (const [key, shot] of this.shots) if (shot.expires < now) {
        this.shots.delete(key); this.predictionOccurrences.delete(shot.id);
      }
    }
    this.check(now, 'reaction deadline');
    // Evaluate real danger before a manual retry can occupy the write slot.
    this.attempts.advance(now);
  }

  private get maxHp(): number { return this.player.maxHp ?? 0; }
  private get threshold(): number { return this.maxHp * this.settings.thresholdPct / 100; }
  private get serverHpAtThreshold(): boolean {
    return this.lastHp !== null && this.maxHp > 0
      && (this.settings.thresholdPct === 0 ? this.lastHp === 0 : this.lastHp <= this.threshold);
  }
  private check(now: number, reason: string): void {
    const predictionReason = this.settings.preHitPrediction ? this.evaluatePrediction(now) : null;
    if (!this.automaticEligible) return;
    if (!this.settings.preHitPrediction || this.settings.thresholdPct === 0) {
      if (this.serverHpAtThreshold) this.request(now, 'server HP threshold', false, reason);
    } else if (predictionReason) this.request(now, predictionReason, false, reason);
  }
  get monitoringReady(): boolean {
    return this.settings.enabled && !this.safe && !this.terminal && this.player.ownerObjectId !== 0 && this.attempts.available;
  }
  get automaticEligible(): boolean {
    return this.monitoringReady && this.attempts.automaticEligible(this.latestNow, this.lastServerAt);
  }
  get phase(): EscapePhase {
    return this.terminal ?? this.attempts.status?.phase ?? (this.map.trim().toLowerCase() === 'nexus' ? 'nexus' : 'armed');
  }
  get degraded(): SafetyStatus['degraded'] {
    if (!this.monitoringReady) return null;
    if (this.hpStreamUnreadable) return 'hp-stream-unreadable';
    return this.latestNow - (this.lastServerAt ?? this.streamStartedAt) > SERVER_HP_STALE_MS
      ? 'server-hp-stale' : this.mapUnreadable ? 'map-unreadable' : null;
  }
  private get protectionState(): ProtectionState {
    if (this.terminal) return this.terminal;
    if (!this.settings.enabled) return 'disabled';
    if (this.safe && this.map.trim()) return 'safe';
    if (!this.monitoringReady) return 'waiting';
    if (this.automaticEligible) return this.degraded ? 'monitoring-degraded' : 'monitoring';
    return this.attempts.recoveryState(this.latestNow) ?? 'escaping';
  }
  uncertain(now: number, reason: string): void {
    this.latestNow = now;
    this.predictor.noteCoverage(reason);
    if (this.settings.preHitPrediction && /capacity|backlog/.test(reason) && this.predictor.pendingCount) this.predictor.fault = reason;
    this.check(now, reason);
  }
  private evaluatePrediction(now: number): string | null {
    this.predictor.expire(now);
    const state = this.predictor.state(now);
    if (this.settings.thresholdPct === 0) return null;
    if (state.fault) return state.fault;
    if ((state.hp === null || this.maxHp <= 0) && state.pendingDamage > 0) return 'health unavailable during observed danger';
    if (state.hp !== null && this.maxHp > 0) {
      if (state.hp <= this.threshold) return 'predicted HP crosses threshold';
      if (state.pendingDamage > 0 && this.lastServerAt !== null
        && now - this.lastServerAt > Math.max(1500, 3 * this.settings.reactionMs)) return 'server health stream stalled during observed danger';
    }
    return null;
  }

  /** One plausible hit from delayed danger; spread count is not a contact count. */
  stalledDanger(packet: Packet, now: number): number {
    if (!packet.isDefined) return 200;
    const d = packet.data;
    const definition: SafetyProjectileDef | undefined = packet.name === 'ENEMYSHOOT'
      ? this.definitions.get(`${this.types.get(d.ownerId)}:${d.bulletType}`)
      : { lifetimeMs: 0, multiHit: false, maxHealthDamage: 0, conditionEffects: [],
          armorPiercing: typeof d.armorPierce === 'boolean' ? d.armorPierce : undefined };
    return assessPredictedLoss(d.damage, definition, this.damageBasis(now)).amount;
  }

  deliveryStalled(now: number, stalledLoss: number): void {
    const reason = 'danger delivery stalled behind plugin processing';
    this.latestNow = now;
    this.predictor.noteCoverage(`${reason}; stalled loss ${stalledLoss}`);
    const hp = this.predictor.lowerHp;
    // Zero and fully credited entries still exist, but carry no remaining loss.
    if (this.settings.preHitPrediction && this.predictor.pendingDamage > 0
      && (hp === null || this.maxHp <= 0 || hp - stalledLoss <= this.threshold)) this.predictor.fault = reason;
    this.check(now, reason);
  }

  decisionEvidence(now: number, trigger: string): SafetyDecisionEvidence {
    const prediction = this.predictor.state(now);
    return { trigger, preHitPrediction: this.settings.preHitPrediction, reactionMs: this.settings.reactionMs,
      retirementEnabled: this.settings.preHitPrediction && prediction.retirementEnabled, graceMs: prediction.graceMs,
      lastHpAgeMs: this.lastHpAt === null ? null : now - this.lastHpAt,
      ...(this.settings.preHitPrediction ? this.predictor.evidence(now) : { pendingCount: 0, pendingDamage: 0, impacts: [] }) };
  }
  request(now: number, reason: string, manual = false, trigger = reason): void {
    this.latestNow = now;
    if (this.terminal || (!manual && !this.automaticEligible)) return;
    if (!manual && !this.settings.preHitPrediction) {
      if (!this.serverHpAtThreshold) return;
      reason = 'server HP threshold';
    }
    const attempt = this.attempts.begin(manual ? 'manual' : 'automatic', now,
      { ...this.settings, retryCount: this.monitoringReady ? this.settings.retryCount : 0 });
    if (!attempt) return;
    this.lastReason = reason;
    const decision: SafetyDecision = { origin: attempt.origin, attemptId: attempt.id,
      connectionGeneration: attempt.connectionGeneration, lifecycleRevision: attempt.lifecycleRevision, reason, epoch: this.epoch,
      confirmedHp: this.lastHp, lowerHp: this.settings.preHitPrediction ? this.predictor.lowerHp : this.lastHp,
      maxHp: this.maxHp, thresholdHp: this.threshold, at: now, evidence: this.decisionEvidence(now, trigger) };
    const wrote = this.attempts.writeInitial(attempt.id);
    this.escape(decision, wrote);
  }
  status(now = this.latestNow): SafetyStatus {
    this.latestNow = now;
    const attempt = this.attempts.status;
    return { preHitPrediction: this.settings.preHitPrediction,
      lowerHp: this.settings.preHitPrediction ? this.predictor.lowerHp : this.lastHp,
      prediction: this.settings.preHitPrediction ? this.predictor.state(now) : null,
      projectileDefinitions: this.definitions.size, conditionsKnown: this.player.conditionsKnown,
      mapUnreadable: this.mapUnreadable, degraded: this.degraded,
      enabled: this.settings.enabled, protectionState: this.protectionState, automaticEligible: this.automaticEligible,
      attemptOrigin: attempt?.origin ?? null, attemptPhase: attempt?.phase ?? null,
      epoch: this.epoch, objectId: this.player.ownerObjectId, map: this.map, phase: this.phase,
      confirmedHp: this.lastHp, maxHp: this.maxHp, lastReason: this.lastReason, reactionMs: this.settings.reactionMs,
      healthAgeMs: this.lastHpAt === null ? null : now - this.lastHpAt,
      streamAgeMs: this.lastServerAt === null ? null : now - this.lastServerAt };
  }
}
