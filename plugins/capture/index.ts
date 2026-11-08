import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { appDataDir } from '../../src/config/store.ts';
import { definePlugin, type PluginContext } from '../../src/plugins/api.ts';
import { PACKETS, Records } from './records.ts';
import { Correlation } from './correlation.ts';
import { CaptureWriter } from './writer.ts';

export function register(ctx: PluginContext): void {
  ctx.name = 'Capture (diagnostics)'; ctx.category = 'utility'; ctx.enabled = false;
  ctx.registerSetting('maxFileMB', { label: 'Max file size (MB)', type: 'number', value: 50, min: 1, max: 500 });
  ctx.registerSetting('includeAllDamage', { label: 'Include all DAMAGE', type: 'boolean', value: false, advanced: true });
  let writer: CaptureWriter | undefined;
  let records = new Records();
  let registered = false, disposed = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const clients = new Map<string, Correlation>();
  let periodStart = performance.now();
  const summary = (activeOnly = false) => {
    const now = performance.now();
    for (const [id, c] of clients) if (!activeOnly || c.lastActivity >= periodStart) ctx.log(c.summary(id, now));
    periodStart = now;
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (writer) { summary(); void writer.close(); writer = undefined; }
  };
  ctx.onEnabledChange(enabled => {
    if (!enabled || disposed) { stop(); return; }
    if (writer) return;
    records = new Records(); clients.clear();
    const currentWriter = new CaptureWriter(join(appDataDir(), 'captures', `capture-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.jsonl`),
      ctx.getSetting<number>('maxFileMB') * 1024 * 1024, s => ctx.log(s), () => { if (writer === currentWriter) ctx.enabled = false; });
    writer = currentWriter; periodStart = performance.now();
    timer = setInterval(() => summary(true), 60_000); timer.unref();
    // API has no observer unsubscribe. Register once, only after explicit enable.
    if (registered) return;
    registered = true;
    for (const name of PACKETS) ctx.observePacket(name, (client, packet) => {
      if (!ctx.enabled || !writer || disposed) return;
      const r = records.record(client, packet, ctx.getSetting<boolean>('includeAllDamage'));
      const id = records.id(client);
      if (id && clients.has(id)) clients.get(id)!.lastActivity = performance.now();
      if (!r) return;
      let correlation = clients.get(r.client);
      if (!correlation) { correlation = new Correlation(); clients.set(r.client, correlation); }
      correlation.add(r); writer.write(r);
    });
  });
  ctx.on('clientDisconnected', client => {
    const id = records.disconnect(client);
    if (id) {
      const c = clients.get(id);
      if (c) ctx.log(c.summary(id, performance.now()));
      clients.delete(id);
    }
  });
  ctx.registerCleanup(() => { disposed = true; stop(); });
}
export default definePlugin({ id: 'capture', name: 'Capture (diagnostics)', apiVersion: 1, capabilities: ['packets'], persistEnabled: false, register });
