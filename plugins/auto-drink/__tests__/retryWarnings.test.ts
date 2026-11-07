import { expect, it } from 'vitest';
import { AutoDrinkController } from '../../../src/auto-drink/AutoDrinkController.ts';
import { fixture, records } from './fixture.ts';

it('keeps slot A exhaustion attributed and logged once while slot B drinks normally', () => {
  const plugin = fixture(); plugin.ctx.enabled = true;
  let now = 0, tick = 0;
  const sent: number[] = [];
  const controller = new AutoDrinkController({ now: () => now, wallNow: () => now,
    send: use => { sent.push(use.slotObject.slotId); return true; } });
  controller.configure({ enabled: true });
  controller.setCatalog([{ type: 10, name: 'Health', hp: 100, mp: 0, healingDurationMs: 0, quickslot: true }]);
  const server = (name: string, data: Record<string, unknown>) => controller.observeServer({ name, data, isDefined: true });
  const stat = (id: number, value: number, stackCount?: number) => ({ id, value, stackCount });
  server('MAPINFO', { name: 'Realm' }); server('CREATESUCCESS', { objectId: 1 });
  server('UPDATE', { newObjs: [{ status: { objectId: 1, position: { x: 1, y: 1 },
    data: [stat(0, 1000), stat(1, 400), stat(116, 10, 3)] } }] });
  const sample = (at: number, data: ReturnType<typeof stat>[] = []) => {
    now = at;
    controller.observeOutgoing({ name: 'PONG', isDefined: true, data: { time: now + 100 } });
    server('NEWTICK', { tickId: ++tick, statuses: [{ objectId: 1, position: { x: 1, y: 1 }, data }] });
  };
  const evaluate = () => {
    controller.evaluate({ available: true, backlog: false, escape: false });
    plugin.status(controller.status());
  };
  sample(0); evaluate();
  for (let at = 500; at <= 7000; at += 500) { sample(at); evaluate(); }
  expect(sent).toEqual([1_000_000, 1_000_000]);
  const exhausted = controller.status().exhaustedSlots;
  expect(exhausted).toEqual([{ slotId: 1_000_000, episode: expect.any(Number),
    reason: 'quickslot 1: drink not confirmed by server' }]);
  // Introduce B after A exhausts; confirm every B write and inspect its cooldown.
  for (let i = 0; i < 3; ++i) {
    sample(8000 + i * 500, [stat(117, 10, 5 - i)]); evaluate();
    expect(sent.at(-1)).toBe(1_000_001);
    expect(controller.status().reason).toBe('awaiting stock decrease');
    sample(8100 + i * 500, [stat(117, 10, 4 - i)]); evaluate();
    expect(controller.status().slotId).toBe(1_000_001);
    expect(controller.status().reason).toBe('quickslot 1: drink not confirmed by server');
    expect(controller.status().exhaustedSlots).toEqual(exhausted);
  }
  const warnings = records.filter(r => r.message.includes('Warning:'));
  expect(warnings).toHaveLength(1);
  expect(warnings[0].message).toContain('quickslot 1: drink not confirmed by server');
  expect(warnings[0].message).not.toContain('quickslot 2');
  sample(9300, [stat(116, 10, 2), stat(117, -1, 0)]); evaluate();
  expect(controller.status().exhaustedSlots).toEqual([]);
  for (let at = 9400; at <= 16400; at += 500) { sample(at); evaluate(); }
  expect(controller.status().exhaustedSlots?.[0].episode).toBeGreaterThan(exhausted![0].episode);
  expect(records.filter(r => r.message.includes('Warning:'))).toHaveLength(2);
});
