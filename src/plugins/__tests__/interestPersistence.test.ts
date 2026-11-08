import { afterEach, expect, it, vi } from 'vitest';
import { definePlugin, type PluginContext } from '../api.ts';
import { IDENTITY_PACKETS } from '../identity.ts';
import { startHost } from '../../testing/pluginHarness.ts';

const registration = (ctx: PluginContext) => {
  ctx.hookPacket('TEXT', () => {});
  ctx.observePacket('AOE', () => {});
  ctx.hookCommand('diagnostic', () => {});
};
const definition = (id: string, register = registration) => definePlugin({
  id, name: id, apiVersion: 1, capabilities: ['packets', 'commands'], register,
});
afterEach(() => vi.restoreAllMocks());

it('refreshes all interest on host and context toggles, preserving shared registrations and identity', () => {
  const h = startHost([definition('a'), definition('b')]);
  try {
    const active = structuredClone(h.proxy.interest);
    expect(active.commands).toEqual(['diagnostic']);
    expect(active.verdict).toEqual({ client: ['PLAYERTEXT'], server: ['TEXT'] });
    expect(active.observe?.server).toContain('AOE');
    h.host.setEnabled('a', false);
    expect(h.proxy.interest).toEqual(active);
    h.host.context('b')!.enabled = false;
    expect(h.proxy.interest).toEqual({
      commands: [], verdict: { client: [], server: [] },
      observe: { client: [], server: [...IDENTITY_PACKETS] },
    });
    const id = h.connect();
    expect(h.packet(id, 'PLAYERTEXT', { text: '/diagnostic' })!.data).not.toBeNull();
    h.host.setEnabled('a', true);
    expect(h.proxy.interest).toEqual(active);
    h.host.context('b')!.enabled = true;
    expect(h.proxy.interest).toEqual(active);
  } finally { h.host.stop(); }
});

it('excludes failed registrations and profile-disabled plugins from startup interest', () => {
  const first = startHost([definition('saved')]);
  first.host.setEnabled('saved', false);
  first.host.stop();
  const h = startHost([
    definition('saved'),
    definition('failed', ctx => { registration(ctx); throw new Error('registration failed'); }),
  ], { profileDir: first.profileDir });
  try {
    expect(h.host.snapshot().find(p => p.id === 'failed')!.failed).toBe('registration failed');
    expect(h.proxy.interest).toEqual({
      commands: [], verdict: { client: [], server: [] },
      observe: { client: [], server: [...IDENTITY_PACKETS] },
    });
    h.host.setEnabled('saved', true);
    expect(h.proxy.interest.commands).toEqual(['diagnostic']);
  } finally { h.host.stop(); }
});

it.each([false, true])('does not restore or save enabled with persistEnabled=false (default %s)', defaultEnabled => {
  const register = (ctx: PluginContext) => {
    ctx.enabled = defaultEnabled;
    ctx.registerSetting('limit', { label: 'Limit', type: 'number', value: 1 });
  };
  const legacy = startHost([definition('diagnostic', register)]);
  legacy.host.setEnabled('diagnostic', !defaultEnabled);
  legacy.host.updateSetting('diagnostic', 'limit', 7);
  legacy.host.stop();
  const diagnostic = { ...definition('diagnostic', register), persistEnabled: false };
  const h = startHost([diagnostic], { profileDir: legacy.profileDir });
  try {
    expect(h.host.context('diagnostic')!.enabled).toBe(defaultEnabled);
    expect(h.host.context('diagnostic')!.getSetting('limit')).toBe(7);
    h.host.setEnabled('diagnostic', !defaultEnabled);
    expect(h.host.context('diagnostic')!.enabled).toBe(!defaultEnabled);
    h.host.updateSetting('diagnostic', 'limit', 9);
    h.host.flush();
    expect(h.profile.load().plugins.diagnostic).toEqual({ settings: { limit: 9 } });
  } finally { h.host.stop(); }
  const restarted = startHost([diagnostic], { profileDir: legacy.profileDir });
  try {
    expect(restarted.host.context('diagnostic')!.enabled).toBe(defaultEnabled);
    expect(restarted.host.context('diagnostic')!.getSetting('limit')).toBe(9);
  } finally { restarted.host.stop(); }
});
