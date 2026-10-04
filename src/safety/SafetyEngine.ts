// Adapted from realm-engine-client client/src/safety/SafetyEngine.ts @ 88a66b2 (MIT, see NOTICE).
import type { Packet } from '../protocol/Packet.ts';
import { ServerPlayerState } from './ServerPlayerState.ts';
import { EscapeAttemptCoordinator, type EscapeTransport } from './EscapeAttemptCoordinator.ts';
import { SAFE_MAPS } from './safeMaps.ts';
import {
  DEFAULT_SAFETY_SETTINGS, safetySettings,
  type SafetySettingsInput, type SafetyDecision, type SafetyStatus, type EscapePhase,
  type SafetyDecisionEvidence, type ProtectionState, type EscapeWriteReceipt,
} from './SafetyTypes.ts';

/** Single-owner, timer-free state machine. All times are monotonic milliseconds. */
export class SafetyEngine {
  settings = { ...DEFAULT_SAFETY_SETTINGS };
  readonly attempts: EscapeAttemptCoordinator;
  player = new ServerPlayerState();
  epoch = 0;
  private terminal: 'dead' | 'transition' | null = null;
  map = '';
  private safe = true;
  private lastServerAt: number | null = null;
  private lastHpAt: number | null = null;
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
    this.settings = normalized;
    // Collision HP (Phase 3b) hooks in here.
    if (wasEnabled !== this.settings.enabled) this.attempts.cancel(now);
    // Toggling is not healing, a new connection, or a transition acknowledgement.
    this.check(now, 'settings changed');
  }

  reset(map = this.map): void {
    this.attempts.reset(++this.epoch); // Invalidate ownership BEFORE processing map/state.
    this.map = typeof map === 'string' ? map : '';
    this.safe = !this.map.trim() || SAFE_MAPS.has(this.map.trim().toLowerCase());
    this.player = new ServerPlayerState();
    // Collision HP (Phase 3b) hooks in here.
    this.lastHp = null; this.lastHpAt = null; this.lastServerAt = null;
    this.lastTick = -1; this.lastReason = '';
  }

  connectionChanged(generation: number): void {
    this.attempts.replaceConnection(generation); this.terminal = null; this.reset('');
  }
  confirmTransition(now: number): void {
    if (this.terminal === 'dead') return;
    this.terminal = 'transition'; this.attempts.cancel(now);
  }
  died(now: number): void { this.terminal = 'dead'; this.attempts.cancel(now); }

  observe(packet: Packet, now: number): void {
    this.latestNow = now;
    const fromClient = packet.direction === 'client';
    // Even unreadable map/character packets retire the old lifecycle.
    if (!fromClient && packet.name === 'MAPINFO') {
      this.reset(packet.isDefined ? packet.data.name ?? '' : ''); return;
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
      if (!fromClient && ['NEWTICK', 'UPDATE', 'DAMAGE'].includes(packet.name)) this.uncertain(now, `unreadable ${packet.name}`);
      return;
    }
    if (fromClient) {
      // Collision HP (Phase 3b) hooks in here.
      return;
    }
    const d = packet.data;
    // The worker adapter must withhold RECONNECT until its validated final write.
    if (packet.name === 'RECONNECT') { this.confirmTransition(now); return; }
    if (packet.name === 'UPDATE') {
      // Collision HP (Phase 3b) hooks in here.
      for (const entity of d.newObjs ?? []) {
        if (entity.status) this.applyStatus(entity.status, now);
      }
    }
    if (packet.name === 'NEWTICK') {
      if (!Number.isInteger(d.tickId) || d.tickId <= this.lastTick) return;
      this.lastTick = d.tickId; this.lastServerAt = now;
      // Collision HP (Phase 3b) hooks in here.
      for (const status of d.statuses ?? []) this.applyStatus(status, now);
      this.check(now, 'server tick');
    }
    if (packet.name === 'DAMAGE' && d.targetId === this.player.ownerObjectId && this.player.ownerObjectId !== 0) {
      if (d.kill === true) { this.lastHp = this.player.hp = 0; this.died(now); return; }
      // Collision HP (Phase 3b) hooks in here.
    }
    // Collision HP (Phase 3b) hooks in here.
  }

  private applyStatus(status: { objectId?: unknown; data?: unknown }, now: number): void {
    if (this.player.ownerObjectId === 0 || status.objectId !== this.player.ownerObjectId) return;
    const hp = this.player.applyStatus(status);
    if (hp !== null) {
      this.lastHp = hp; this.lastHpAt = now; this.lastServerAt = now;
      // Collision HP (Phase 3b) hooks in here.
    }
    this.check(now, 'server health');
  }

  advance(now: number): void {
    this.latestNow = now;
    // Collision HP (Phase 3b) hooks in here.
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
    // Collision HP (Phase 3b) hooks in here.
    if (!this.automaticEligible) return;
    if (this.serverHpAtThreshold) this.request(now, 'server HP threshold', false, reason);
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
  private get protectionState(): ProtectionState {
    if (this.terminal) return this.terminal;
    if (!this.settings.enabled) return 'disabled';
    if (this.safe && this.map.trim()) return 'safe';
    if (!this.monitoringReady) return 'waiting';
    if (this.automaticEligible) return 'monitoring';
    return this.attempts.recoveryState(this.latestNow) ?? 'escaping';
  }
  uncertain(now: number, reason: string): void {
    this.latestNow = now;
    // Collision HP (Phase 3b) hooks in here.
    this.check(now, reason);
  }
  decisionEvidence(_now: number, trigger: string): SafetyDecisionEvidence {
    // Collision HP (Phase 3b) hooks in here.
    return { trigger, preHitPrediction: false, reactionMs: this.settings.reactionMs,
      pendingCount: 0, pendingDamage: 0, impacts: [] };
  }
  request(now: number, reason: string, manual = false, trigger = reason): void {
    this.latestNow = now;
    if (this.terminal || (!manual && !this.automaticEligible)) return;
    // Collision HP (Phase 3b) hooks in here.
    if (!manual) {
      if (!this.serverHpAtThreshold) return;
      reason = 'server HP threshold';
    }
    const attempt = this.attempts.begin(manual ? 'manual' : 'automatic', now,
      { ...this.settings, retryCount: this.monitoringReady ? this.settings.retryCount : 0 });
    if (!attempt) return;
    this.lastReason = reason;
    const decision: SafetyDecision = { origin: attempt.origin, attemptId: attempt.id,
      connectionGeneration: attempt.connectionGeneration, lifecycleRevision: attempt.lifecycleRevision, reason, epoch: this.epoch,
      confirmedHp: this.lastHp, lowerHp: this.lastHp,
      maxHp: this.maxHp, thresholdHp: this.threshold, at: now, evidence: this.decisionEvidence(now, trigger) };
    const wrote = this.attempts.writeInitial(attempt.id);
    this.escape(decision, wrote);
  }
  status(now = this.latestNow): SafetyStatus {
    this.latestNow = now;
    const attempt = this.attempts.status;
    return { enabled: this.settings.enabled, protectionState: this.protectionState, automaticEligible: this.automaticEligible,
      attemptOrigin: attempt?.origin ?? null, attemptPhase: attempt?.phase ?? null,
      epoch: this.epoch, objectId: this.player.ownerObjectId, map: this.map, phase: this.phase,
      confirmedHp: this.lastHp, maxHp: this.maxHp, lastReason: this.lastReason, reactionMs: this.settings.reactionMs,
      healthAgeMs: this.lastHpAt === null ? null : now - this.lastHpAt,
      streamAgeMs: this.lastServerAt === null ? null : now - this.lastServerAt };
  }
}
