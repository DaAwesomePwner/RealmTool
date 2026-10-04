// Adapted from realm-engine-client client/src/proxy/network-worker.ts @ 88a66b2 (MIT, see NOTICE).
import type { PendingDelivery, WorkerModule } from '../../src/transport/modules.ts';
import { SafetyEngine } from '../../src/safety/SafetyEngine.ts';
import { AutoEscapeReportGuard } from '../../src/safety/AutoEscapeReportGuard.ts';
import { safetySettings, type SafetySettings, type SafetySettingsInput } from '../../src/safety/SafetyTypes.ts';
import type { AutoNexusEvent } from './messages.ts';
import { toSafetyCatalog, validateSafetyCatalog } from '../../src/data/safety.ts';
import type { SafetyCatalog, SafetyCatalogState } from '../../src/safety/SafetyCatalog.ts';

interface Configuration {
  settings: SafetySettings;
  catalog: SafetyCatalog;
  catalogState: SafetyCatalogState;
  collisionHp: AutoNexusEvent['collisionHp'];
}
let config = configuration({ settings: safetySettings({}), catalog: null,
  catalogState: { state: 'fallback', reason: 'not loaded' } });
const sessions = new Set<(config: Configuration) => void>();
const reports = ['PLAYERHIT', 'AOEACK', 'GROUNDDAMAGE'];
const dangers = ['ENEMYSHOOT', 'AOE'];

function configuration(config: unknown): Configuration {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid Auto Nexus configuration');
  const value = (config as { settings?: unknown }).settings;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Auto Nexus settings');
  const input = value as Record<string, unknown>;
  for (const key of ['enabled', 'notification', 'preHitPrediction']) {
    if (key in input && typeof input[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
  }
  for (const key of ['thresholdPct', 'retryCount', 'retryMs', 'reactionMs']) {
    if (key in input && (typeof input[key] !== 'number' || !Number.isFinite(input[key]))) throw new Error(`${key} must be a finite number`);
  }
  const settings = safetySettings(input as SafetySettingsInput);
  const supplied = config as Record<string, unknown>;
  const file = supplied.catalog === null ? null : validateSafetyCatalog(supplied.catalog);
  const state = supplied.catalogState;
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Invalid Auto Nexus catalog state');
  const fields = state as Record<string, unknown>;
  let catalogState: SafetyCatalogState;
  if (file) {
    if (fields.state !== 'ready' || fields.gameBuild !== file.gameBuild
      || fields.projectiles !== file.projectiles.length || fields.tiles !== file.tiles.length) {
      throw new Error('Auto Nexus catalog state does not match catalog');
    }
    catalogState = { state: 'ready', gameBuild: file.gameBuild, projectiles: file.projectiles.length, tiles: file.tiles.length };
  } else {
    if (fields.state !== 'fallback' || typeof fields.reason !== 'string' || !fields.reason.trim()) {
      throw new Error('Invalid Auto Nexus catalog fallback reason');
    }
    catalogState = { state: 'fallback', reason: fields.reason };
  }
  // Normalize and convert everything before touching defaults or any live engine.
  return { settings: { ...settings, preHitPrediction: settings.preHitPrediction && file !== null },
    catalog: file ? toSafetyCatalog(file) : { projectiles: [], tiles: [] }, catalogState,
    collisionHp: !settings.preHitPrediction ? 'off' : file ? 'on' : 'fallback' };
}

export const autoNexusModule: WorkerModule = {
  id: 'auto-nexus', priority: 0,
  observe: { server: ['MAPINFO', 'CREATESUCCESS', 'UPDATE', 'NEWTICK', 'DAMAGE', 'DEATH', ...dangers, 'GOTO'], client: reports },
  prepare: reports,
  writtenServer: ['RECONNECT', ...dangers],
  configure(value) {
    const next = configuration(value);
    config = next;
    for (const configure of sessions) configure(next);
  },
  createSession(context) {
    let closed = false;
    let guard = new AutoEscapeReportGuard(context.generation());
    let lastStatusAt = -Infinity;
    let current = config;
    const stalledLosses = new Map<number, number>();
    const unpreparedReports = new Set<number>();
    const deliveries = new Map<number, number | null>();
    const clear = () => { stalledLosses.clear(); unpreparedReports.clear(); deliveries.clear(); };
    const post = (event: AutoNexusEvent) => context.post(event);
    const engine = new SafetyEngine(decision => {
      context.automation.latchEscape(decision.origin === 'manual' ? 'manual escape' : 'auto escape');
      guard.activate(decision, engine.attempts);
      post({ type: 'decision', decision, status: engine.status(context.now()), writeDelayMs: context.now() - decision.at,
        catalog: current.catalogState, collisionHp: current.collisionHp });
    }, {
      now: () => context.now(),
      available: () => context.transport().available,
      blocked: () => context.transport().upstreamBackpressure,
      write: done => context.writePriority(context.factory.serialize(context.factory.createByName('ESCAPE')), false, done, 'auto-nexus'),
    }, receipt => { guard.activate(receipt, engine.attempts); });
    // SafetyEngine owns its ServerPlayerState and EscapeAttemptCoordinator.
    engine.connectionChanged(context.generation());
    const configure = (next: Configuration) => {
      current = next;
      engine.setCatalog(next.catalog);
      engine.configure(next.settings, context.now());
    };
    configure(config);
    sessions.add(configure);
    const status = (now: number) => {
      lastStatusAt = now;
      post({ type: 'status', status: engine.status(now), sampledAt: now, generation: context.generation(),
        catalog: current.catalogState, collisionHp: current.collisionHp });
    };
    const backlog = (now: number, pending: readonly PendingDelivery[]) => engine.deliveryBacklog(
      context.transport().upstreamBackpressure || (pending.length > 0 && now - pending[0].receivedAt > 100));
    return {
      observe(packet, fromClient, now, observationId) {
        if (closed) return;
        // Snapshots must also see backlog changes between periodic ticks.
        backlog(now, context.pendingDelivery());
        if (fromClient && reports.includes(packet.name)) unpreparedReports.add(observationId);
        engine.observe(packet, now, observationId);
        if (!fromClient && dangers.includes(packet.name)) stalledLosses.set(observationId, engine.stalledDanger(packet, now));
      },
      prepareWrite({ token, packet, now, observationId }) {
        if (closed) return;
        // Once prepared, only writeOutcome owns delivery (a veto also emits dropped).
        if (observationId !== null) unpreparedReports.delete(observationId);
        const deliveryId = engine.preparePredictionWrite(packet, now, observationId);
        if (!closed) deliveries.set(token, deliveryId);
      },
      writeOutcome(token, accepted, now) {
        if (closed || !deliveries.has(token)) return;
        const deliveryId = deliveries.get(token)!;
        deliveries.delete(token);
        engine.reportDelivered(deliveryId, now, accepted);
      },
      dropped(observationId, _name, _fromClient, now) {
        if (closed) return;
        stalledLosses.delete(observationId);
        if (unpreparedReports.delete(observationId)) engine.reportDelivered(observationId, now, false);
      },
      writtenServer(packet, _kind, now, observationId) {
        if (closed) return;
        if (observationId !== null) stalledLosses.delete(observationId);
        if (packet.name === 'RECONNECT') {
          engine.confirmTransition(now);
          context.automation.latchEscape('transfer');
        }
      },
      suppressEntry: (name, fromClient) => guard.suppresses(fromClient, name),
      allowWrite: (name, toClient) => !guard.suppresses(!toClient, name),
      tick(now) {
        if (closed) return;
        const pending = context.pendingDelivery();
        backlog(now, pending);
        let stalledLoss = 0, stalled = false;
        for (const entry of pending) {
          if (entry.fromClient || entry.generation !== context.generation() || !dangers.includes(entry.name)) continue;
          stalledLoss += stalledLosses.get(entry.observationId) ?? 0;
          if (now - entry.receivedAt > Math.min(100, current.settings.reactionMs / 4)) stalled = true;
        }
        if (stalled) engine.deliveryStalled(now, stalledLoss);
        engine.advance(now);
        if (now - lastStatusAt >= 200) status(now);
      },
      connectionChanged(generation) {
        if (closed) return;
        clear();
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
      close() { closed = true; sessions.delete(configure); clear(); engine.attempts.cancel(context.now()); },
    };
  },
};
