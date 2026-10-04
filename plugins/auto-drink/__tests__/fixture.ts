import { afterEach, beforeEach, vi } from 'vitest';
import { ProfileStore, type Profile } from '../../../src/config/store.ts';
import { startHost } from '../../../src/testing/pluginHarness.ts';
import { log, type LogRecord } from '../../../src/util/log.ts';
import { createAutoDrinkPlugin } from '../index.ts';
import type { CatalogLoad } from '../../../src/data/consumables.ts';
import type { PluginDefinition } from '../../../src/plugins/api.ts';
import type { AutoDrinkConfig } from '../messages.ts';

export const item = { type: 42, name: 'Mana', hp: 0, mp: 60, healingDurationMs: 0, quickslot: true };
export const catalog: CatalogLoad = { ok: true, path: 'test', catalog: {
  schemaVersion: 1, gameBuild: 'test-build', source: { objectsSha256: 'a'.repeat(64) }, items: [item],
} };
export const workerStatus = { enabled: true, state: 'cooldown', reason: 'shared interval', hp: 30, maxHp: 100,
  slotId: 1_000_002, itemType: 42, lastAttemptAt: 12345, cooldownRemainingMs: 375, pending: true, epoch: 2 };
export const records: LogRecord[] = [];
const cleanups: (() => void)[] = [];
let removeSink: () => void;
beforeEach(() => { records.length = 0; log.setConsole(false); removeSink = log.addSink(r => records.push(r)); });
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); removeSink(); log.setConsole(true); vi.restoreAllMocks(); });

export function fixture(options: { profile?: Profile; catalog?: CatalogLoad; others?: PluginDefinition[];
  gameDir?: string | null; buildReader?: (gameDir: string) => string } = {}) {
  const load = vi.spyOn(ProfileStore.prototype, 'load').mockReturnValue(options.profile ?? { schemaVersion: 1, plugins: {} });
  const loader = vi.fn(() => options.catalog ?? catalog);
  const buildReader = vi.fn(options.buildReader ?? (() => 'test-build'));
  const h = startHost([createAutoDrinkPlugin(loader, buildReader), ...(options.others ?? [])], {
    gameDir: options.gameDir === undefined ? 'C:/fixture/game' : options.gameDir,
  });
  load.mockRestore();
  cleanups.push(() => h.host.stop());
  const ctx = h.host.context('auto-drink')!;
  const clients = new Set<string>();
  return { ...h, ctx, loader, buildReader,
    config: () => h.proxy.configured.at(-1)?.['auto-drink'] as AutoDrinkConfig,
    status: (status = workerStatus, id = 'connection-a', generation = 1) => {
      if (!clients.has(id)) { h.connect(id); clients.add(id); }
      h.workerMessage(id, 'auto-drink', { type: 'status', status, generation });
    },
    data: () => h.host.data('auto-drink')?.get('status') as typeof workerStatus & { clientId: string | null },
  };
}
