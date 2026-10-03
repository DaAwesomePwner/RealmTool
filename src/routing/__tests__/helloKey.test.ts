import { describe, expect, it } from 'vitest';
import { findHelloKeyOffset, patchHelloKey } from '../helloKey.ts';
import { createFactory } from '../../protocol/schema.ts';
import { helloBytes } from '../../testing/wire.ts';

describe('HELLO key patching', () => {
  const factory = createFactory();

  it('replaces only the key and keeps every other byte', () => {
    const raw = helloBytes(factory, Buffer.from('token-123'));
    const offset = findHelloKeyOffset(raw);
    expect(offset).toBeGreaterThan(5);
    const realKey = Buffer.from([0, 0xff, 0x80, 0x42]);
    const patched = patchHelloKey(raw, offset, realKey);
    expect(patched.readInt32BE(0)).toBe(patched.length);
    const before = factory.createFromBytes(raw, 'client');
    const after = factory.createFromBytes(patched, 'client');
    expect((after.data.key as Buffer).equals(realKey)).toBe(true);
    expect({ ...after.data, key: null }).toEqual({ ...before.data, key: null });
  });

  it('returns -1 for a truncated HELLO', () => {
    const raw = helloBytes(factory, Buffer.from('token'));
    expect(findHelloKeyOffset(raw.subarray(0, 12))).toBe(-1);
  });
});
