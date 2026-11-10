// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import { Readiness } from '../readiness.ts';
import type { AppState } from '../api.ts';
import { PluginCards } from '../plugins.ts';

it('shows the stopped/failed recovery path and honest helper/session state', async () => {
  const state: AppState = {
    data: { state: 'idle', gameBuild: null, catalogBuild: null, lastResult: null, error: null },
    proxy: { state: 'failed', port: null, error: 'Select a game folder' },
    game: { dir: null, candidates: ['C:\\Games\\Exalt'], launcher: null, helper: { state: 'unknown', backup: false } },
    sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 1,
  };
  const api = { post: vi.fn().mockResolvedValue(state), get: vi.fn() };
  const changed = vi.fn(); const view = new Readiness(api, changed); view.update(state);
  // Status, actions and notices sit in the top bar; the folder controls sit in the Setup tab.
  const all = document.createElement('div'); all.append(view.status, view.actions, view.notices, view.element);
  expect(view.notices.textContent).toContain('Select a game folder');
  expect(view.element.querySelector('input')!.getAttribute('aria-invalid')).toBe('true');
  const buttons = [...all.querySelectorAll('button')];
  const start = buttons.find(button => button.textContent === 'Start proxy')!;
  expect(start.disabled).toBe(false); start.click(); await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledWith('/api/proxy/start', {});
  view.update({ ...state, proxy: { state: 'running', port: 2050, error: null }, game: { ...state.game, dir: 'C:\\Games\\Exalt', helper: { state: 'installed', backup: true } } });
  expect(buttons.find(button => button.textContent === 'Uninstall helper')!.disabled).toBe(true);
  expect(view.status.textContent).toContain('0 connected of 0 open');
  expect(view.status.textContent).toContain('installed');
  const cards = new PluginCards(api, changed); cards.update([]);
  expect(cards.element.textContent).toBe('Start the proxy to view and edit plugin settings');
});

it('offers refresh during a live session and displays progress, result and failure', async () => {
  const state: AppState = {
    data: { state: 'idle', gameBuild: 'A', catalogBuild: 'A', lastResult: null, error: null },
    proxy: { state: 'running', port: 2050, error: null },
    game: { dir: 'fixture', candidates: [], launcher: null, helper: { state: 'installed', backup: false } },
    sessions: { open: 1, connected: 1 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 1,
  };
  const api = { post: vi.fn().mockResolvedValue({}) }, changed = vi.fn();
  const view = new Readiness(api, changed); view.update(state);
  const refresh = [...view.element.querySelectorAll('button')].find(b => b.textContent === 'Refresh game data')!;
  expect(refresh.disabled).toBe(false); refresh.click();
  await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/refresh-data', {});
  view.update({ ...state, data: { ...state.data, state: 'refreshing' } });
  expect(refresh.disabled).toBe(true); expect(view.element.textContent).toContain('Refreshing game data');
  const lastResult = { gameBuild: 'B', items: 2, projectiles: 3, tiles: 4, ms: 16_000 };
  view.update({ ...state, data: { ...state.data, lastResult } });
  expect(refresh.disabled).toBe(false); expect(view.element.textContent).toContain('2 items, 3 projectiles, 4 tiles (16000 ms)');
  view.update({ ...state, data: { ...state.data, state: 'failed', lastResult, error: 'fixture failure' } });
  expect(view.element.textContent).toContain('fixture failure');
  expect(view.element.textContent).toContain('2 items, 3 projectiles, 4 tiles (16000 ms)');
});

it.each(['idle', 'protected', 'degraded', 'unprotected'] as const)('renders protection %s first and explains reasons', state => {
  const view = new Readiness({ post: vi.fn() }, vi.fn());
  view.update({ protection: { state, since: 1, reasons: [{ code: 'test', source: 'test', severity: 'warning', message: '<unsafe> reason' }] },
    data: { state: 'idle', gameBuild: null, catalogBuild: null, error: null, lastResult: null },
    proxy: { state: 'running', port: 2050, error: null }, game: { dir: null, candidates: [], launcher: null, helper: { state: 'installed', backup: false } },
    sessions: { open: 1, connected: 1 }, profile: { active: 'default', available: [] }, operation: null, revision: 1 });
  const item = view.status.firstElementChild!;
  expect(item.getAttribute('data-key')).toBe('protection'); expect(item.getAttribute('data-value')).toBe(state);
  expect(item.hasAttribute('aria-live')).toBe(false); expect(view.status.getAttribute('aria-live')).toBe('polite');
  expect(item.textContent).toContain({ idle: 'Idle', protected: 'Protected', degraded: 'Degraded', unprotected: 'Not protected' }[state]);
  expect(view.notices.textContent).toContain('<unsafe> reason'); expect(view.notices.querySelector('unsafe')).toBeNull();
});

it('retains the protection element, filters info reasons, and renders missing protection as unknown', () => {
  const view = new Readiness({ post: vi.fn() }, vi.fn());
  const state: AppState = { data: { state: 'idle', gameBuild: null, catalogBuild: null, error: null, lastResult: null },
    proxy: { state: 'stopped', port: null, error: null }, game: { dir: null, candidates: [], launcher: null, helper: { state: 'unknown', backup: false } },
    sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: [] }, operation: null, revision: 1 };
  view.update(state); const item = view.status.firstElementChild!, value = item.querySelector('strong');
  expect(item.getAttribute('data-value')).toBe('unknown'); expect(item.textContent).toContain('Unknown');
  view.update({ ...state, protection: { state: 'idle', since: 1, reasons: [
    { code: 'info', source: 'proxy', severity: 'info', message: 'Hidden info' },
    { code: 'warn', source: 'helper', severity: 'warning', message: 'Visible warning' },
    { code: 'error', source: 'helper', severity: 'error', message: 'Visible error' }] } });
  expect(view.status.firstElementChild).toBe(item); expect(item.querySelector('strong')).toBe(value);
  expect(item.textContent).toContain('Idle'); expect(view.notices.textContent).not.toContain('Hidden info');
  expect(view.notices.textContent).toContain('Visible warning'); expect(view.notices.textContent).toContain('Visible error');
});

it('dismisses close warnings without reviving them on updates and expires new warnings', () => {
  vi.useFakeTimers();
  try {
    const state: AppState = {
      data: { state: 'idle', gameBuild: null, catalogBuild: null, lastResult: null, error: null },
      proxy: { state: 'running', port: 2050, error: null },
      game: { dir: null, candidates: [], launcher: null, helper: { state: 'unknown', backup: false } },
      sessions: { open: 0, connected: 0 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 1,
      safetyWarning: { message: 'Connection closed at 18% HP', expiresAt: Date.now() + 60000 },
    };
    const view = new Readiness({ post: vi.fn() }, () => {});
    view.update(state);
    expect(view.notices.textContent).toContain('18% HP');
    const dismiss = view.notices.querySelector('button');
    const content = view.notices.querySelector('.warning')!.firstChild;
    view.update(structuredClone(state));
    expect(view.notices.querySelector('button')).toBe(dismiss);
    expect(view.notices.querySelector('.warning')!.firstChild).toBe(content);
    view.notices.querySelector('button')!.click();
    view.update(state);
    expect(view.notices.textContent).not.toContain('18% HP');
    state.safetyWarning = { message: 'Connection closed at 20% HP', expiresAt: Date.now() + 60001 };
    view.update(state);
    expect(view.notices.textContent).toContain('20% HP');
    vi.advanceTimersByTime(60001);
    expect(view.notices.textContent).not.toContain('20% HP');
    view.update(state);
    expect(view.notices.textContent).not.toContain('20% HP');
  } finally { vi.useRealTimers(); }
});
