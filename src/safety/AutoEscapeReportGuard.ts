// Ported from realm-engine-client client/src/proxy/AutoEscapeReportGuard.ts @ 88a66b2 (MIT, see NOTICE).
import type { EscapeAttemptCoordinator } from './EscapeAttemptCoordinator.ts';
import type { EscapeWriteReceipt, SafetyDecision } from './SafetyTypes.ts';

const REPORTS = new Set(['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE', 'MOVE']);

/** One upstream TCP generation's latch; only connection/session replacement releases it. */
export class AutoEscapeReportGuard {
  private active = false;

  private readonly generation: number;
  constructor(generation: number) { this.generation = generation; }

  /** Called before telemetry for a decision or an OWN automatic write notification. */
  activate(trigger: SafetyDecision | EscapeWriteReceipt,
    attempts: Pick<EscapeAttemptCoordinator, 'status' | 'acceptedReceipt'>): boolean {
    const current = attempts.status;
    if (trigger.origin !== 'automatic' || trigger.connectionGeneration !== this.generation
      || !current || current.origin !== 'automatic' || current.id !== trigger.attemptId
      || current.connectionGeneration !== this.generation || current.epoch !== trigger.epoch
      || current.lifecycleRevision !== trigger.lifecycleRevision) return false;
    // The coordinator rejects failed/retired attempts and wrong-lifecycle receipts.
    const accepted = attempts.acceptedReceipt(current.id);
    if (!accepted) return false;
    if ('writeId' in trigger && (!trigger.accepted || trigger.failed || trigger.shared
      || accepted.shared || accepted.origin !== 'automatic' || accepted.writeId !== trigger.writeId)) return false;
    // Only an actual automatic DECISION may use an accepted shared manual write.
    // Once armed, later errors, map epochs and settings cannot unsend that ESCAPE.
    this.active = true;
    return true;
  }

  suppresses(fromClient: boolean, packetName: string): boolean {
    return this.active && fromClient && REPORTS.has(packetName);
  }
}

