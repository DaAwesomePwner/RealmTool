// Adapted from realm-engine-client client/scripts/replay-hp-prediction.ts @ 88a66b2 (MIT, see NOTICE).
import { HealthPredictor, type LossAssessment } from '../HealthPredictor.ts';

export type ReplayEvent = { at: number; kind: 'reset' | 'tick' | 'hp' | 'hit' | 'written';
  hp?: number; maxHp?: number; rtt?: number; id?: number; amount?: number; assumed?: boolean;
  assessmentKind?: LossAssessment['kind'] };
export interface HpReplay { schema: 1; description: string; events: ReplayEvent[] }
export function replayHpPrediction(fixture: HpReplay) {
  const predictor = new HealthPredictor();
  const samples: { at: number; serverHp: number | null; modeledHp: number | null; pendingDamage: number; pendingCount: number; retired: number }[] = [];
  const hits = new Set<number>(); let totalRaw = 0, retirements = 0, maxHp = 0;
  let firstCrossing: number | null = null;
  for (const e of fixture.events) {
    if (e.kind === 'reset') { retirements += predictor.state(e.at).retiredCount; predictor.reset(); maxHp = 0; }
    if (e.kind === 'tick') predictor.timing(e.at, e.rtt);
    if (e.kind === 'hp') { predictor.snapshot(e.hp!, e.at); maxHp = e.maxHp ?? maxHp; }
    if (e.kind === 'hit') {
      if (!hits.has(e.id!)) { hits.add(e.id!); totalRaw += e.amount!; }
      const assessment: LossAssessment = { amount: e.amount!, kind: e.assessmentKind ?? (e.assumed ? 'assumed' : 'mitigated-estimate'), reason: e.assumed ? 'recorded unresolved hit' : null };
      predictor.impact(String(e.id), assessment, e.at, 'player-hit', e.at + 12000, e.id!);
    }
    if (e.kind === 'written') predictor.delivered(e.id!, e.at, 'written');
    const state = predictor.state(e.at);
    if (firstCrossing === null && state.hp !== null && maxHp > 0 && state.hp <= .25 * maxHp) firstCrossing = e.at;
    if (e.kind === 'hp' || e.kind === 'hit') samples.push({ at: e.at, serverHp: predictor.hp, modeledHp: state.hp,
      pendingDamage: state.pendingDamage, pendingCount: state.pendingCount, retired: state.retiredCount });
  }
  return { distinctHits: hits.size, totalAssessedDamage: totalRaw,
    estimatedRetirements: retirements + predictor.state(fixture.events.at(-1)?.at ?? 0).retiredCount,
    firstHypotheticalThresholdCrossingMs: firstCrossing, samples };
}
