// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { AppState } from '../api.ts';
import { StatusFooter } from '../footer.ts';

const state: AppState = {
  data: { state: 'idle', gameBuild: null, catalogBuild: null, lastResult: null, error: null },
  proxy: { state: 'running', port: 2050, error: null },
  game: { dir: 'fixture', candidates: [], launcher: null, helper: { state: 'installed', backup: false } },
  sessions: { open: 0, connected: 0 }, profile: { active: 'raiding', available: ['default', 'raiding'] }, operation: null, revision: 1,
};
const visible = (footer: StatusFooter) => [...footer.element.querySelectorAll<HTMLElement>('.statusbar-item')]
  .filter(item => !item.hidden).map(item => item.textContent);

it('shows connection, profile, operation only while set, and loop p99 with the max in a title', () => {
  const footer = new StatusFooter();
  expect(footer.connection.textContent).toBe('Connecting to backend…');
  expect(footer.connection.getAttribute('role')).toBe('status');
  footer.setConnection('Backend connected', 'ok');
  expect(footer.connection.textContent).toBe('Backend connected');
  expect(footer.connection.parentElement!.dataset.tone).toBe('ok');
  // The connection element holds only its text, so the smoke test reads it unchanged.
  expect(footer.connection.children).toHaveLength(0);
  footer.update(state);
  expect(visible(footer)).toEqual(['Backend connected', 'Profile raiding']);
  footer.update({ ...state, operation: 'Switching profile', loopLag: {
    worker: { p99: 10.94, max: 25, degraded: false }, main: { p99: 11.5, max: 40.25, degraded: true } } });
  expect(visible(footer)).toEqual(['Backend connected', 'Profile raiding', 'Operation Switching profile', 'Network loop 10.9 ms', 'Main loop 11.5 ms']);
  const loop = (key: string) => footer.element.querySelector<HTMLElement>(`[data-key="${key}"]`)!;
  expect(loop('loop-worker').title).toContain('max 25.0 ms');
  expect(loop('loop-main').title).toContain('max 40.3 ms');
  expect(loop('loop-main').dataset.degraded).toBe('true');
  footer.update(state);
  expect(visible(footer)).toEqual(['Backend connected', 'Profile raiding']);
  footer.setConnection('Connection lost. Reconnecting…', 'pending');
  expect(footer.connection.parentElement!.dataset.tone).toBe('pending');
});
