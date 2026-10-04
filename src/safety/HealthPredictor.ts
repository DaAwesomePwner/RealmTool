// Adapted from realm-engine-client client/src/safety/HealthPredictor.ts @ 88a66b2 (MIT, see NOTICE).
export type ImpactSource = 'player-hit' | 'server-damage' | 'ground' | 'aoe';

export interface LossAssessment {
  amount: number;
  kind: 'mitigated-estimate' | 'measured' | 'assumed';
  reason: string | null;
  raw?: number | null; defense?: number | null; effectiveDefense?: number;
  effects?: number; effects2?: number; basisRevision?: number; basisAgeMs?: number | null;
}
interface Impact {
  at: number; assessment: LossAssessment; source: ImpactSource; writtenAt: number | null;
  serverSeenAt: number | null; expiresAt: number; credited: number;
}
export interface PredictionState {
  hp: number | null; pendingCount: number; pendingDamage: number; assumedCount: number;
  retiredCount: number; creditedDamage: number; graceMs: number; retirementEnabled: boolean;
  coverage: string; fault: string | null;
}
interface PredictionEvidence {
  pendingCount: number; pendingDamage: number;
  impacts: { id: string; amount: number; source: ImpactSource; ageMs: number;
    kind: LossAssessment['kind']; credited: number; writtenAt: number | null }[];
}

/** Worker-owned accounting. Server snapshots have no proven impact-inclusion marker.
 * All retirement in this implementation is explicitly estimated, never an ACK.
 * No clocks, timers, sockets, callbacks or native display HP can change this model.
 */
export class HealthPredictor {
  static readonly CAPACITY = 512;
  hp: number | null = null;
  revision = 0;
  private impacts = new Map<string, Impact>();
  private settled = new Map<string, number>();
  private reports = new Map<number, string>();
  private ticks: number[] = [];
  private rtts: number[] = [];
  private lastTickAt: number | null = null;
  private healthyTicks = 0;
  private backlogged = false;
  private burstGrace = 1000;
  private retired = 0;
  private credited = 0;
  private coverage = 'reported collisions; estimated reconciliation';
  fault: string | null = null;

  reset(): void {
    this.hp = null; this.revision = 0; this.clearDebt();
    this.ticks = []; this.rtts = []; this.lastTickAt = null; this.healthyTicks = 0;
  }
  clearDebt(): void {
    this.impacts.clear(); this.settled.clear(); this.reports.clear();
    this.retired = this.credited = 0; this.fault = null;
    this.backlogged = false; this.burstGrace = 1000;
    this.coverage = 'reported collisions; estimated reconciliation';
  }
  timing(now: number, rtt: unknown): void {
    if (this.lastTickAt !== null) {
      const interval = now - this.lastTickAt;
      if (interval > 0 && interval <= 1500) {
        this.ticks.push(interval); if (this.ticks.length > 128) this.ticks.shift();
        ++this.healthyTicks;
      } else if (interval > 1500) this.healthyTicks = 0;
    }
    this.lastTickAt = now;
    if (typeof rtt === 'number' && Number.isFinite(rtt) && rtt > 0 && rtt <= 60000) {
      this.rtts.push(rtt); if (this.rtts.length > 128) this.rtts.shift();
    }
  }
  deliveryBacklog(value: boolean): void { this.backlogged = value; }
  private p99(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * .99) - 1)] ?? 0;
  }
  private get candidateGrace(): number {
    // Reconciliation is transport timing, not the geometric look-ahead setting.
    return this.rtts.length && this.ticks.length
      ? Math.max(250, this.p99(this.rtts) + 2 * this.p99(this.ticks) + 100) : 1000;
  }
  get graceMs(): number {
    // A settings/timing change must not shorten an outstanding burst's liability.
    return this.impacts.size ? Math.max(this.burstGrace, this.candidateGrace) : this.candidateGrace;
  }
  private retirementAllowed(now: number): boolean {
    return !this.backlogged && this.healthyTicks >= 2 && this.lastTickAt !== null
      && now - this.lastTickAt <= 1500 && this.graceMs <= 2500;
  }
  snapshot(hp: number, now: number): void {
    if (!Number.isFinite(hp) || hp < 0) return;
    let observedLoss = this.hp === null ? 0 : Math.max(0, this.hp - hp);
    this.hp = hp; ++this.revision;
    this.expire(now);
    if (!this.retirementAllowed(now)) return;
    const grace = this.graceMs;
    // No packet inclusion marker exists. Credit only this snapshot's net loss,
    // oldest eligible delivered reports first, and never carry unused credit.
    // Half the observed RTT is a causal exclusion estimate for very recent writes,
    // NOT proof of inclusion. Healing never supplies reconciliation credit.
    const causalDelay = Math.max(25, this.p99(this.rtts) / 2);
    for (const [id, hit] of this.impacts) {
      const since = hit.writtenAt ?? hit.serverSeenAt;
      if (since !== null && now - since >= causalDelay && observedLoss > 0) {
        const credit = Math.min(observedLoss, Math.max(0, hit.assessment.amount - hit.credited));
        hit.credited += credit; this.credited += credit; observedLoss -= credit;
      }
      // Receipt alone, a blocked report and an HP-less tick cannot retire a hit.
      if (since === null || now - since < grace) continue;
      this.impacts.delete(id); this.settled.set(id, Math.max(hit.expiresAt, now + grace)); ++this.retired;
      for (const [observation, impact] of this.reports) if (impact === id) this.reports.delete(observation);
    }
  }
  impact(id: string, assessment: LossAssessment, now: number, source: ImpactSource,
    expiresAt = now + 12000, observationId: number | null = null, measured = false): boolean {
    if (!Number.isFinite(assessment.amount) || assessment.amount < 0) {
      this.fault = 'invalid impact assessment'; return false;
    }
    this.expire(now);
    if (this.settled.has(id)) return true;
    const previous = this.impacts.get(id);
    if (!previous && this.impacts.size + this.settled.size >= HealthPredictor.CAPACITY) {
      this.fault = 'HP prediction impact capacity'; return false;
    }
    if (observationId !== null && !this.reports.has(observationId) && this.reports.size >= HealthPredictor.CAPACITY) {
      this.fault = 'HP prediction delivery capacity'; return false;
    }
    if (!this.impacts.size) this.burstGrace = this.candidateGrace;
    this.burstGrace = Math.max(this.burstGrace, this.candidateGrace);
    if (previous) {
      // A later condition/DEF change cannot rewrite an already incurred hit.
      if (measured) previous.assessment = { ...previous.assessment, ...assessment };
      if (measured) previous.serverSeenAt ??= now;
    } else {
      this.impacts.set(id, { at: now, assessment, source, writtenAt: null,
        serverSeenAt: measured ? now : null, expiresAt, credited: 0 });
    }
    if (observationId !== null) this.reports.set(observationId, id);
    return true;
  }
  delivered(observationId: number | null, now: number, result: 'written' | 'blocked'): void {
    if (observationId === null) return;
    const id = this.reports.get(observationId);
    if (!id) return;
    const hit = this.impacts.get(id);
    if (hit && result === 'written') hit.writtenAt ??= now;
    // Blocked is not proof that a native/server loss was undone. Retain the loss.
    this.reports.delete(observationId);
  }
  has(id: string): boolean { return this.impacts.has(id) || this.settled.has(id); }
  assessment(id: string): LossAssessment | undefined {
    const hit = this.impacts.get(id);
    if (hit) return hit.assessment;
    return undefined;
  }
  expire(now: number): void {
    for (const [id, expiresAt] of this.settled) if (expiresAt < now) this.settled.delete(id);
  }
  noteCoverage(reason: string): void { this.coverage = reason.slice(0, 240); }
  get pendingCount(): number { return this.impacts.size; }
  get pendingDamage(): number { return this.evidence(0).pendingDamage; }
  get lowerHp(): number | null {
    return this.hp === null ? null : Math.max(0, this.hp - this.evidence(0).pendingDamage);
  }
  evidence(now: number): PredictionEvidence {
    let pendingDamage = 0;
    const impacts: PredictionEvidence['impacts'] = [];
    for (const [id, hit] of this.impacts) {
      const remaining = Math.max(0, hit.assessment.amount - hit.credited);
      pendingDamage += remaining;
      if (impacts.length < 8) impacts.push({ id, amount: remaining, source: hit.source, ageMs: now - hit.at,
        kind: hit.assessment.kind, credited: hit.credited, writtenAt: hit.writtenAt });
    }
    return { pendingCount: this.impacts.size, pendingDamage, impacts };
  }
  state(now: number): PredictionState {
    const debt = this.evidence(now);
    return { hp: this.lowerHp,
      pendingCount: debt.pendingCount, pendingDamage: debt.pendingDamage,
      assumedCount: [...this.impacts.values()].filter(h => h.assessment.kind === 'assumed').length,
      retiredCount: this.retired, graceMs: this.graceMs, retirementEnabled: this.retirementAllowed(now),
      creditedDamage: this.credited,
      coverage: this.coverage, fault: this.fault };
  }
}
