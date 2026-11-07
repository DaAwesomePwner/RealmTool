// Adapted from realm-engine-client client/src/safety/SafetyTypes.ts @ 88a66b2 (MIT, see NOTICE).
import type { HealthPredictor, PredictionState } from './HealthPredictor.ts';

/** Collision HP estimates are optional; explicit server HP remains authoritative. */
export interface SafetySettings {
  enabled: boolean;
  preHitPrediction: boolean;
  thresholdPct: number;
  notification: boolean;
  retryCount: number;
  retryMs: number;
  reactionMs: number;
}

/** Accept retired input keys without carrying them into normalized settings. */
export type SafetySettingsInput = Partial<Omit<SafetySettings, 'preHitPrediction'>> & {
  preHitPrediction?: unknown;
  burstGuard?: unknown;
  instantNexus?: unknown;
  predictionModel?: unknown;
  forecastTiming?: unknown;
};

export const DEFAULT_SAFETY_SETTINGS: Readonly<SafetySettings> = Object.freeze({
  enabled: false, preHitPrediction: true, thresholdPct: 25, notification: true,
  retryCount: 4, retryMs: 400, reactionMs: 400,
});

export function safetySettings(value: SafetySettingsInput): SafetySettings {
  const number = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
  return {
    enabled: value.enabled === true,
    preHitPrediction: value.preHitPrediction !== false,
    thresholdPct: number(value.thresholdPct, 25, 0, 100),
    notification: value.notification !== false,
    retryCount: Math.trunc(number(value.retryCount, 4, 0, 10)),
    retryMs: number(value.retryMs, 400, 100, 2000),
    reactionMs: number(value.reactionMs, 400, 200, 2000),
  };
}

export type EscapePhase = 'armed' | 'requested' | 'queued' | 'written' | 'transition' | 'nexus' | 'dead' | 'failed';
export type ProtectionState = 'disabled' | 'waiting' | 'safe' | 'monitoring' | 'monitoring-degraded' | 'escaping' | 'cooldown' | 'degraded' | 'transition' | 'dead';
/** Monotonic worker times. Physical origin is retained even when a decision shares this write. */
export interface EscapeWriteReceipt {
  writeId: number;
  attemptId: number;
  origin: 'manual' | 'automatic';
  connectionGeneration: number;
  epoch: number;
  lifecycleRevision: number;
  enqueuedAt: number;
  accepted: boolean;
  completedAt: number | null;
  failed: boolean;
  shared: boolean;
}
export interface EscapeAttemptStatus {
  id: number;
  origin: 'manual' | 'automatic';
  connectionGeneration: number;
  epoch: number;
  lifecycleRevision: number;
  phase: 'requested' | 'queued' | 'written' | 'failed';
  requestedAt: number;
  lastWriteAt: number | null;
  writeId: number | null;
  failure: 'unavailable' | 'backpressure' | 'write-error' | 'write-stalled' | 'unconfirmed' | null;
  writeReceipt?: EscapeWriteReceipt | null;
}
export interface SafetyDecisionEvidence {
  trigger: string;
  preHitPrediction: boolean;
  reactionMs: number;
  retirementEnabled: boolean;
  graceMs: number;
  lastHpAgeMs: number | null;
  pendingCount: number;
  pendingDamage: number;
  impacts: ReturnType<HealthPredictor['evidence']>['impacts'];
}
export interface SafetyDecision {
  origin: 'manual' | 'automatic';
  attemptId: number;
  connectionGeneration: number;
  lifecycleRevision: number;
  reason: string;
  epoch: number;
  confirmedHp: number | null;
  lowerHp: number | null;
  maxHp: number;
  thresholdHp: number;
  at: number;
  evidence: SafetyDecisionEvidence;
}
export interface SafetyStatus {
  mapUnreadable: boolean;
  degraded: null | 'server-hp-stale' | 'hp-stream-unreadable' | 'map-unreadable';
  preHitPrediction: boolean;
  lowerHp: number | null;
  prediction: PredictionState | null;
  projectileDefinitions: number;
  conditionsKnown: boolean;
  enabled: boolean;
  protectionState: ProtectionState;
  automaticEligible: boolean;
  attemptOrigin: EscapeAttemptStatus['origin'] | null;
  attemptPhase: EscapeAttemptStatus['phase'] | null;
  epoch: number;
  objectId: number;
  map: string;
  phase: EscapePhase;
  confirmedHp: number | null;
  maxHp: number;
  lastReason: string;
  reactionMs: number;
  healthAgeMs: number | null;
  streamAgeMs: number | null;
}
