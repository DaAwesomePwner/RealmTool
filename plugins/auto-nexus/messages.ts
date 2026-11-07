import type { SafetyDecision, SafetySettings, SafetyStatus } from '../../src/safety/SafetyTypes.ts';
import type { SafetyCatalogFile, SafetyCatalogState } from '../../src/safety/SafetyCatalog.ts';

/** Enabled comes from the plugin's enabled state. */
export interface AutoNexusConfig {
  settings: SafetySettings;
  /** null = no usable catalog: Collision HP falls back to server HP only. */
  catalog: SafetyCatalogFile | null;
  catalogState: SafetyCatalogState;
}
export type AutoNexusCommand = { type: 'escape' };
export type AutoNexusEvent = (
  | { type: 'decision'; decision: SafetyDecision; status: SafetyStatus; writeDelayMs: number }
  | { type: 'status'; status: SafetyStatus; sampledAt: number; generation: number }
) & { latency?: import('../../src/transport/latency.ts').LatencySummary; catalog: SafetyCatalogState; collisionHp: 'on' | 'off' | 'fallback' };
