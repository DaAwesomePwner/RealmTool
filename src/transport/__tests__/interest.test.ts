import { describe, expect, it } from 'vitest';
import { Interest } from '../interest.ts';

describe('Interest', () => {
  it('replaces registered command names with every interest update', () => {
    const interest = new Interest({ commands: ['con'] });
    expect(interest.isCommand('/CON usw ')).toBe(true);
    expect(interest.isCommand('/ con')).toBe(false);
    expect(interest.isCommand('/tell bob hi')).toBe(false);
    interest.set({ commands: ['other'] });
    expect(interest.isCommand('/con')).toBe(false);
    expect(interest.isCommand('/other')).toBe(true);
    interest.set({});
    expect(interest.isCommand('/other')).toBe(false);
  });

  it.each([['RECONNECT', false], ['DEATH', false], ['MAPINFO', false], ['ESCAPE', true]] as const)(
    'downgrades critical %s verdict interest to observe', (name, fromClient) => {
      const interest = new Interest();
      expect(interest.classify(name, fromClient)).toBe('none');
      interest.set({ verdict: { [fromClient ? 'client' : 'server']: [name] } });
      expect(interest.classify(name, fromClient)).toBe('observe');
    });

  it('classifies per direction, with verdict winning over observe', () => {
    const interest = new Interest({
      verdict: { server: ['TEXT'], client: ['ENEMYHIT'] },
      observe: { server: ['TEXT', 'MAPINFO'], client: ['MOVE'] },
    });
    expect(interest.classify('TEXT', false)).toBe('verdict');
    expect(interest.classify('TEXT', true)).toBe('none');
    expect(interest.classify('ENEMYHIT', true)).toBe('verdict');
    expect(interest.classify('MAPINFO', false)).toBe('observe');
    expect(interest.classify('MOVE', true)).toBe('observe');
    expect(interest.classify('NEWTICK', false)).toBe('none');
  });

  it('supports an observe-everything wildcard and replacement', () => {
    const interest = new Interest({ observe: { server: ['*'] } });
    expect(interest.classify('NEWTICK', false)).toBe('observe');
    interest.set({});
    expect(interest.classify('NEWTICK', false)).toBe('none');
  });
});
