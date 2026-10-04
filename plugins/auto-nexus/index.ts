// Adapted from realm-engine-client client/plugins/auto-nexus.ts @ 88a66b2 (MIT, see NOTICE).
import { definePlugin, type ClientConnection, type PluginContext } from '../../src/plugins/api.ts';
import { safetySettings } from '../../src/safety/SafetyTypes.ts';
import { SETTING_DEFS, migrate, validate } from './settings.ts';
import type { AutoNexusConfig, AutoNexusEvent } from './messages.ts';

const ZERO_SUFFIX = ' (proactive escapes suppressed; confirmed server zero only; manual Nexus available)';
const ROUTING = 'routing: normal ESCAPE; server-authorized transfer; automatic escape report suppression policy: after accepted local AUTO escape until new connection; manual ESCAPE alone unaffected';

export function register(ctx: PluginContext): void {
  ctx.name = 'Auto Nexus'; ctx.category = 'combat';
  const configuration = (enabled = ctx.enabled): AutoNexusConfig => ({ settings: safetySettings({ enabled,
    thresholdPct: ctx.getSetting('ForceAutoNexusHealth'), notification: ctx.getSetting('ShowChatMessageOnNexus'),
    retryCount: ctx.getSetting('EscapeRetryCount'), retryMs: ctx.getSetting('EscapeRetryIntervalMs'),
  }), catalog: null, catalogState: { state: 'fallback', reason: 'not loaded' } });
  const sync = () => ctx.worker.configure(configuration());
  for (const { key, ...def } of SETTING_DEFS) ctx.registerSetting(key, def, () => {
    sync();
    if (key === 'ForceAutoNexusHealth') {
      const t = ctx.getSetting<number>(key);
      ctx.log(`Nexus threshold set to ${t}%${t === 0 ? ZERO_SUFFIX : ''}`);
    }
  });
  sync(); ctx.onEnabledChange(sync);
  ctx.registerCleanup(() => ctx.worker.configure(configuration(false)));

  // Worker timestamps use the process-wide monotonic clock, not wall time.
  // Generation notifications are ordered on this session's worker channel.
  const views = new WeakMap<ClientConnection, { generation: number; sample?: Extract<AutoNexusEvent, { type: 'status' }> }>();
  ctx.worker.onMessage((client, message) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return;
    const event = message as AutoNexusEvent;
    if (event.type === 'status') {
      if (!Number.isInteger(event.generation) || event.generation < 0) return;
      const current = views.get(client);
      if (current && event.generation < current.generation) return;
      views.set(client, { generation: event.generation, sample: event });
    } else if (event.type === 'decision') {
      const { decision, writeDelayMs } = event;
      const current = views.get(client);
      if (!current || decision.connectionGeneration > current.generation) views.set(client, { generation: decision.connectionGeneration });
      const label = decision.origin === 'manual' ? 'MANUAL NEXUS' : 'AUTO NEXUS';
      const t = ctx.getSetting<number>('ForceAutoNexusHealth');
      const text = `Server HP ${decision.confirmedHp ?? '?'}/${decision.maxHp}; threshold ${t}%; ${decision.reason}; Collision HP off; local write attempt ${writeDelayMs.toFixed(3)}ms (not server acceptance)`;
      ctx.log(`${label} — ${text}`);
      if (ctx.getSetting<boolean>('ShowChatMessageOnNexus')) ctx.sendNotification(client, label, text);
    }
  });
  ctx.hookCommand('an', (client, _command, args) => {
    if (args.length) {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 0 || value > 100) { ctx.sendNotification(client, 'AutoNexus', 'Usage: /an [0-100]'); return; }
      ctx.updateSetting('ForceAutoNexusHealth', value);
    }
    const view = views.get(client);
    const sample = view?.sample;
    const age = sample ? performance.now() - sample.sampledAt : NaN;
    const fresh = sample && sample.generation === view?.generation && Number.isFinite(age) && age >= 0 && age <= 2000;
    if (sample && !fresh) view!.sample = undefined; // A stale sample cannot revive after a clock anomaly.
    const status = fresh ? sample.status : undefined;
    const t = ctx.getSetting<number>('ForceAutoNexusHealth');
    ctx.sendNotification(client, 'AutoNexus', `Threshold ${t}%${t === 0 ? ZERO_SUFFIX : ''}; `
      + (status ? `worker ${status.enabled ? 'enabled' : 'disabled'}; automatic ${status.automaticEligible ? 'eligible' : 'not eligible'}; protection ${status.protectionState}; prediction off — server HP threshold only; attempt ${status.attemptOrigin === 'manual' ? 'MANUAL NEXUS' : status.attemptOrigin} ${status.attemptPhase}; `
        : 'Worker status unavailable / awaiting current worker; ') + ROUTING);
  });
  ctx.hookCommand('reset', client => ctx.sendNotification(client, 'AutoNexus', 'Collision HP is not available yet: Auto Nexus uses the server HP threshold only, so there is no estimated damage to reset.'));
  ctx.hookCommand('nexus', client => ctx.worker.send(client, { type: 'escape' }));
  ctx.log('Loaded — server HP threshold only (Collision HP arrives in a later update); 25% default until saved settings apply; isolated network safety lane; automatic escape report suppression policy: after accepted local AUTO escape until new connection; manual ESCAPE alone unaffected');
}

export default definePlugin({ id: 'auto-nexus', name: 'Auto Nexus', apiVersion: 1,
  capabilities: ['packets', 'commands', 'notifications', 'worker'], register, settings: { validate, migrate } });
