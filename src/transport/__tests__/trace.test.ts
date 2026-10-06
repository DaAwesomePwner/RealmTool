import { describe, expect, it } from 'vitest';
import { SessionTrace } from '../trace.ts';

describe('SessionTrace', () => {
  it('summarizes both directions, first server packets and timing', () => {
    const trace = new SessionTrace(1000);
    trace.received(true, 'HELLO', 512, 1000);
    trace.sent(false, 512);
    trace.helloSent(1100);
    trace.received(false, 'MAPINFO', 2048, 1310);
    trace.sent(true, 2048);
    trace.received(false, 'NEWTICK', 1024, 3000);
    trace.sent(true, 1024);
    trace.sent(true, 100, true);
    trace.dropped(false);
    expect(trace.summary(13_400, [], { game: 0, server: 0 })).toBe('Session summary after 12.4 s; '
      + 'game→proxy 1 frames (0.5 KB), last 12.4 s ago; proxy→server 1 frames (0.5 KB); '
      + 'server→proxy 2 frames (3.0 KB), first 210 ms after HELLO, last 10.4 s ago; '
      + 'proxy→game 3 frames (3.1 KB), 1 written by RealmTool; dropped 0 from game, 1 from server; '
      + 'first server packets: MAPINFO, NEWTICK');
  });

  it('reports a server that never answered', () => {
    const trace = new SessionTrace(0);
    trace.received(true, 'HELLO', 500, 0);
    trace.helloSent(100);
    expect(trace.summary(5100, [], { game: 0, server: 0 })).toContain('server→proxy nothing (HELLO sent 5.0 s ago)');
    expect(new SessionTrace(0).summary(0, [], { game: 0, server: 0 })).toContain('(HELLO never sent)');
  });

  it('lists held packets and data the peers have not taken', () => {
    const trace = new SessionTrace(0);
    const held = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, fromClient: i === 0, ageMs: 1500 }));
    const text = trace.summary(2000, held, { game: 4096, server: 512 });
    expect(text).toContain('held 6 awaiting a plugin: P0 from game 1.5 s, P1 from server 1.5 s, P2 from server 1.5 s, '
      + 'P3 from server 1.5 s, P4 from server 1.5 s, …');
    expect(text).toContain('4.0 KB not yet taken by the game; 0.5 KB not yet taken by the server');
  });

  it('keeps only the first server packet names', () => {
    const trace = new SessionTrace(0);
    for (let i = 0; i < 12; i++) trace.received(false, `S${i}`, 10, i);
    expect(trace.summary(20, [], { game: 0, server: 0 })).toMatch(/first server packets: S0, S1, S2, S3, S4, S5, S6, S7$/);
  });
});
