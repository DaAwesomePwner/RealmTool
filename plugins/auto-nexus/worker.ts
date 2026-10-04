// Adapted from realm-engine-client client/src/proxy/network-worker.ts @ 88a66b2 (MIT, see NOTICE).
import type { WorkerModule } from '../../src/transport/modules.ts';
import { SafetyEngine } from '../../src/safety/SafetyEngine.ts';
import { AutoEscapeReportGuard } from '../../src/safety/AutoEscapeReportGuard.ts';
import { safetySettings, type SafetySettings, type SafetySettingsInput } from '../../src/safety/SafetyTypes.ts';
import type { AutoNexusEvent } from './messages.ts';

let settings = safetySettings({});
const sessions = new Set<(settings: SafetySettings) => void>();

function configuration(config: unknown): SafetySettings {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Auto Nexus configuration');
  const value = (config as { settings?: unknown }).settings;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Auto Nexus settings');
  const input = value as Record<string, unknown>;
  for (const key of ['enabled', 'notification']) {
    if (key in input && typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  for (const key of ['thresholdPct', 'retryCount', 'retryMs', 'reactionMs']) {
    if (key in input && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) throw new Error(`${key} must be a finite number`);
  }
  // Validate before touching either the module defaults or a live engine.
  return safetySettings(input as SafetySettingsInput);
}

export const autoNexusModule: WorkerModule = {
  id: 'auto-nexus', priority: 0,
  observe: { server: ['MAPINFO', 'CREATESUCCESS', 'UPDATE', 'NEWTICK', 'DAMAGE', 'DEATH'] },
  writtenServer: ['RECONNECT'],
  configure(config) {
    const next = configuration(config);
    settings = next;
    for (const configure of sessions) configure(next);
  },
  createSession(context) {
    let closed = false;
    let guard = new AutoEscapeReportGuard(context.generation());
    let lastStatusAt = -Infinity;
    const post = (event: AutoNexusEvent) => context.post(event);
    const engine = new SafetyEngine(decision => {
      context.automation.latchEscape(decision.origin === 'manual' ? 'manual escape' : 'auto escape');
      guard.activate(decision, engine.attempts);
      post({ type: 'decision', decision, status: engine.status(context.now()), writeDelayMs: context.now() - decision.at });
    }, {
      now: () => context.now(),
      available: () => context.transport().available,
      blocked: () => context.transport().upstreamBackpressure,
      write: done => context.writePriority(context.factory.serialize(context.factory.createByName('ESCAPE')), false, done, 'auto-nexus'),
    }, receipt => { guard.activate(receipt, engine.attempts); });
    // SafetyEngine owns its ServerPlayerState and EscapeAttemptCoordinator.
    engine.connectionChanged(context.generation());
    const configure = (next: SafetySettings) => engine.configure(next, context.now());
    configure(settings);
    sessions.add(configure);
    const status = (now: number) => {
      lastStatusAt = now;
      post({ type: 'status', status: engine.status(now), sampledAt: now, generation: context.generation() });
    };
    return {
      observe(packet, _fromClient, now) { if (!closed) engine.observe(packet, now); },
      writtenServer(packet, _kind, now) {
        if (closed || packet.name !== 'RECONNECT') return;
        engine.confirmTransition(now);
        context.automation.latchEscape('transfer');
      },
      suppressEntry: (name, fromClient) => guard.suppresses(fromClient, name),
      allowWrite: (name, toClient) => !guard.suppresses(!toClient, name),
      tick(now) {
        if (closed) return;
        engine.advance(now);
        if (now - lastStatusAt >= 200) status(now);
      },
      connectionChanged(generation) {
        if (closed) return;
        guard = new AutoEscapeReportGuard(generation);
        engine.connectionChanged(generation);
        // Invalidate the facade's old generation immediately, before the next periodic sample.
        status(context.now());
      },
      command(message) {
        if (!closed && message && typeof message === 'object' && 'type' in message && message.type === 'escape') {
          engine.request(context.now(), 'manual nexus', true);
        }
      },
      close() { closed = true; sessions.delete(configure); engine.attempts.cancel(context.now()); },
    };
  },
};
