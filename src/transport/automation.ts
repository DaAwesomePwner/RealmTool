/** Worker-local automation state for one game socket, shared by every module of that session. Never crosses to the main thread. */
export class SessionAutomation {
  private reason: string | null = null;
  private currentGeneration = 0;

  /** True from the first escape decision (accepted or rejected, manual or automatic) or an accepted transfer until the upstream generation changes. */
  escapeLatched(): boolean { return this.reason !== null; }

  /** Latch for the current generation; `reason` is kept for status (e.g. 'auto escape', 'manual escape', 'transfer'). */
  latchEscape(reason: string): void { this.reason ??= reason; }

  get latchReason(): string | null { return this.reason; }
  get generation(): number { return this.currentGeneration; }

  /** Called by Session before modules' connectionChanged; clears the latch. */
  reset(generation: number): void {
    this.currentGeneration = generation;
    this.reason = null;
  }
}
