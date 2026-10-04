import { describe, expect, it } from 'vitest';
import { SessionAutomation } from '../automation.ts';

describe('SessionAutomation', () => {
  it('keeps the first escape reason until reset and records the generation', () => {
    const state = new SessionAutomation();
    expect(state.escapeLatched()).toBe(false);
    expect(state.latchReason).toBeNull();
    expect(state.generation).toBe(0);
    state.reset(1);
    state.latchEscape('auto escape');
    state.latchEscape('transfer');
    expect(state.escapeLatched()).toBe(true);
    expect(state.latchReason).toBe('auto escape');
    state.reset(2);
    expect(state.generation).toBe(2);
    expect(state.escapeLatched()).toBe(false);
    expect(state.latchReason).toBeNull();
    state.latchEscape('manual escape');
    expect(state.latchReason).toBe('manual escape');
  });
});
