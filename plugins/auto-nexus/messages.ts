import type { SafetyDecision, SafetySettings, SafetyStatus } from '../../src/safety/SafetyTypes.ts';

/** Enabled comes from the plugin's enabled state. */
export interface AutoNexusConfig { settings: SafetySettings }
export type AutoNexusCommand = { type: 'escape' };
export type AutoNexusEvent =
  | { type: 'decision'; decision: SafetyDecision; status: SafetyStatus; writeDelayMs: number }
  | { type: 'status'; status: SafetyStatus; sampledAt: number; generation: number };
