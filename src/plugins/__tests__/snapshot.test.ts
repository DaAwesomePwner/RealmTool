import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BUILTIN_PLUGINS } from '../../../plugins/index.ts';
import { ProfileStore } from '../../config/store.ts';
import { createFactory } from '../../protocol/schema.ts';
import { FakeProxy } from '../../testing/pluginHarness.ts';
import { log } from '../../util/log.ts';
import { definePlugin, type PluginDefinition } from '../api.ts';
import { PluginHost, type ProxyLike } from '../host.ts';
import { toJsonSafe } from '../snapshot.ts';

const cleanup: (() => void)[] = [];
beforeEach(() => { log.setConsole(false); cleanup.push(log.addSink(() => {})); });
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); log.setConsole(true); });
function fixture(definitions: readonly PluginDefinition[] = BUILTIN_PLUGINS) {
  const dir = mkdtempSync(join(tmpdir(), 'snapshots-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const profile = new ProfileStore({ dir });
  const proxy = new FakeProxy();
  const onChange = vi.fn();
  const host = new PluginHost({ definitions, profile, proxy: proxy as unknown as ProxyLike, factory: createFactory(), onChange });
  host.start(); cleanup.push(() => host.stop());
  return { host, proxy, profile, onChange };
}
it('snapshots every built-in in order, current values and transient settings, excluding hidden settings', () => {
  const { host } = fixture();
  host.context('chat-filter')!.updateSetting('previewMessage', 'test');
  const snapshots = host.snapshot();
  expect(snapshots.map(p => p.id)).toEqual(BUILTIN_PLUGINS.map(p => p.id));
  expect(snapshots[0].settings.some(s => s.hidden || s.key === 'schemaVersion')).toBe(false);
  expect(snapshots[0].settings.find(s => s.key === 'previewMessage')).toMatchObject({ value: 'test', transient: true });
  snapshots[0].settings[0].value = 'mutated';
  expect(host.snapshot()[0].settings[0].value).not.toBe('mutated');
});
it('retains registration and API failures and rejects enabling them', () => {
  const { host } = fixture([
    definePlugin({ id: 'bad', name: 'Bad', apiVersion: 1, capabilities: [], register() { throw new Error('broken'); } }),
    definePlugin({ id: 'old', name: 'Old', apiVersion: 99, capabilities: [], register() {} }),
  ]);
  expect(host.snapshot()).toMatchObject([{ id: 'bad', failed: 'broken', enabled: false, settings: [], data: {} }, { id: 'old', failed: expect.any(String), settings: [], data: {} }]);
  expect(host.setEnabled('bad', true).ok).toBe(false);
});
it('copies JSON-safe data with bounded strings and depth', () => {
  const cycle: Record<string, unknown> = { big: 12n, fn: () => {}, missing: undefined, long: 'x'.repeat(5000) };
  cycle.self = cycle;
  let deep: unknown = 'leaf';
  for (let i = 0; i < 20; i++) deep = { child: deep };
  const result = toJsonSafe({ cycle, deep, array: [undefined, () => {}, 1], nan: NaN }) as any;
  expect(result.cycle.big).toBe('12');
  expect(result.cycle).not.toHaveProperty('fn');
  expect(result.cycle).not.toHaveProperty('missing');
  expect(result.cycle.long).toHaveLength(4000);
  expect(JSON.stringify(result)).not.toContain('leaf');
  expect(() => JSON.stringify(result)).not.toThrow();
});
it('preserves validator clamping, exact rejection messages and unchanged profiles on rejection', () => {
  const { host, profile, proxy } = fixture();
  expect(host.updateSetting('auto-nexus', 'ForceAutoNexusHealth', 150)).toEqual({ ok: true });
  expect(host.snapshot().find(p => p.id === 'auto-nexus')!.settings.find(s => s.key === 'ForceAutoNexusHealth')!.value).toBe(100);
  const save = vi.spyOn(profile, 'scheduleSave');
  expect(host.updateSetting('auto-nexus', 'PreHitPrediction', 'false')).toEqual({ ok: false, error: 'PreHitPrediction must be a boolean' });
  expect(save).not.toHaveBeenCalled();
  expect(host.updateSetting('auto-nexus', 'PreHitPrediction', false)).toEqual({ ok: true });
  expect(proxy.configured.at(-1)).toMatchObject({ 'auto-nexus': { settings: { preHitPrediction: false } } });
});
it('rejects unknown, hidden and disabled buttons and returns generic validation messages', () => {
  const button = vi.fn();
  const { host, profile } = fixture([definePlugin({ id: 'p', name: 'P', apiVersion: 1, capabilities: [], register(ctx) {
    ctx.registerSetting('n', { label: 'N', type: 'number', value: 1, max: 2 });
    ctx.registerSetting('secret', { label: 'Secret', type: 'text', value: '', hidden: true });
    ctx.registerSetting('go', { label: 'Go', type: 'button', value: undefined }, button);
  } })]);
  host.setEnabled('p', false);
  const save = vi.spyOn(profile, 'scheduleSave');
  expect(host.updateSetting('p', 'n', 3)).toEqual({ ok: false, error: 'Invalid value for n' });
  for (const key of ['missing', 'secret', 'go']) expect(host.updateSetting('p', key, true).ok).toBe(false);
  expect(host.updateSetting('missing', 'n', 1).ok).toBe(false);
  expect(host.setEnabled('missing', true).ok).toBe(false);
  expect(save).not.toHaveBeenCalled(); expect(button).not.toHaveBeenCalled();
});
it('notifies enable, setting and data changes without persisting data', () => {
  const { host, profile, onChange } = fixture();
  onChange.mockClear();
  host.setEnabled('auto-nexus', false);
  host.updateSetting('auto-nexus', 'PreHitPrediction', false);
  const save = vi.spyOn(profile, 'scheduleSave');
  host.context('auto-nexus')!.setData('status', { hp: 1 });
  expect(onChange.mock.calls).toEqual([['auto-nexus'], ['auto-nexus'], ['auto-nexus']]);
  expect(save).not.toHaveBeenCalled();
  expect(host.snapshot().find(p => p.id === 'auto-nexus')!.data).toEqual({ status: { hp: 1 } });
});
