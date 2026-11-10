// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest';
import type { AppState, Protection } from '../api.ts';
import { Readiness } from '../readiness.ts';

const base: AppState = {
  data: { state: 'idle', gameBuild: null, catalogBuild: null, lastResult: null, error: null },
  proxy: { state: 'running', port: 2050, error: null },
  game: { dir: 'fixture', candidates: [], launcher: null, helper: { state: 'installed', backup: false } },
  sessions: { open: 2, connected: 1 }, profile: { active: 'default', available: ['default'] }, operation: null, revision: 1,
};
const reasons: Protection['reasons'] = [
  { code: 'info', source: 'game', severity: 'info', message: 'Waiting for the game' },
  { code: 'nexus', source: 'auto-nexus', severity: 'error', message: 'Auto Nexus is off' },
  { code: 'data', source: 'data', severity: 'warning', message: 'Game data is stale' },
];
const render = (protection: (Protection & { since: number }) | undefined, state: Partial<AppState> = {}) => {
  const view = new Readiness({ post: vi.fn() }, vi.fn());
  view.update({ ...base, ...state, protection });
  const item = view.status.querySelector<HTMLElement>('[data-key="protection"]')!;
  return { view, item, sentence: item.querySelector('.protection-sentence')!.textContent, icon: item.querySelector('svg')! };
};

it.each([
  ['idle', reasons, 'No game connected. Press Launch to start.', 1],
  ['protected', [], 'Game traffic is going through the proxy', 2],
  ['degraded', reasons, 'Auto Nexus is off', 2],
  ['unprotected', reasons, 'Auto Nexus is off', 2],
] as const)('explains %s with one sentence and a matching shield', (state, list, sentence, paths) => {
  const { item, sentence: text, icon } = render({ state, since: 1, reasons: [...list] });
  expect(item.dataset.value).toBe(state); expect(text).toBe(sentence);
  expect(icon.getAttribute('aria-hidden')).toBe('true'); expect(icon.querySelectorAll('path')).toHaveLength(paths);
});

it('uses the first non-info reason, a generic sentence without one, and waits for the backend when unknown', () => {
  const warningFirst = [reasons[0], reasons[2], reasons[1]];
  expect(render({ state: 'degraded', since: 1, reasons: warningFirst }).sentence).toBe('Game data is stale');
  expect(render({ state: 'degraded', since: 1, reasons: [reasons[0]] }).sentence).toBe('Protection is running with problems');
  expect(render({ state: 'unprotected', since: 1, reasons: [] }).sentence).toBe('Game traffic is not protected');
  const unknown = render(undefined);
  expect(unknown.item.dataset.value).toBe('unknown'); expect(unknown.item.textContent).toContain('Unknown');
  expect(unknown.sentence).toBe('Waiting for the backend');
});

it('shows proxy, helper and sessions as facts with status dots, and no profile, operation or loop timings', () => {
  const { view } = render({ state: 'protected', since: 1, reasons: [] }, {
    operation: 'Launching', loopLag: { worker: { p99: 3, max: 9, degraded: false } },
  });
  const fact = (key: string) => view.status.querySelector<HTMLElement>(`.fact[data-key="${key}"]`)!;
  expect(fact('proxy').querySelector<HTMLElement>('.dot')!.dataset.tone).toBe('ok');
  expect(fact('helper').querySelector<HTMLElement>('.dot')!.dataset.tone).toBe('ok');
  expect(fact('sessions').querySelector('dd')!.textContent).toBe('1 connected of 2 open');
  expect(fact('sessions').querySelector('.muted')!.textContent).toBe('of 2 open');
  expect(fact('sessions').querySelector<HTMLElement>('.fact-text')!.title).toBe('1 connected, 2 open');
  expect(view.status.textContent).not.toMatch(/Profile|Operation|loop/);
  view.update({ ...base, proxy: { state: 'failed', port: null, error: 'boom' }, game: { ...base.game, helper: { state: 'absent', backup: false } } });
  expect(fact('proxy').querySelector<HTMLElement>('.dot')!.dataset.tone).toBe('bad');
  expect(fact('helper').querySelector<HTMLElement>('.dot')!.dataset.tone).toBe('off');
  view.update({ ...base, proxy: { state: 'starting', port: null, error: null } });
  expect(fact('proxy').querySelector<HTMLElement>('.dot')!.dataset.tone).toBe('off');
  expect([...view.actions.children].map(button => button.textContent)).toEqual(['Start proxy', 'Launch']);
  expect(view.actions.lastElementChild!.className).toBe('primary');
});
