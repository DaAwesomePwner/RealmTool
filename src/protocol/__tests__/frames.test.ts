import { describe, expect, it } from 'vitest';
import { FrameDecoder, isWholeFrame } from '../frames.ts';
import { RC4Cipher } from '../RC4Cipher.ts';
import { RC4_KEYS } from '../constants.ts';
import { frame } from '../../testing/wire.ts';

function encryptAll(frames: Buffer[]): Buffer {
  const cipher = new RC4Cipher(RC4_KEYS.serverToClient);
  return Buffer.concat(frames.map(plain => { const copy = Buffer.from(plain); cipher.cipher(copy); return copy; }));
}

describe('FrameDecoder', () => {
  it('reassembles coalesced and fragmented frames and decrypts them in order', () => {
    const plain = [frame(10, Buffer.from('first')), frame(42, Buffer.alloc(300, 7)), frame(44, Buffer.from('third'))];
    const wire = encryptAll(plain);
    const decoder = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    const out: Buffer[] = [];
    // Split at awkward points: inside a length header and inside a body.
    for (const chunk of [wire.subarray(0, 2), wire.subarray(2, 20), wire.subarray(20)]) {
      decoder.feed(chunk, f => out.push(f));
    }
    expect(out.map(f => f.toString('hex'))).toEqual(plain.map(f => f.toString('hex')));
    expect(decoder.incomplete).toBe(false);
  });

  it('reports a partial frame as incomplete', () => {
    const decoder = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    decoder.feed(encryptAll([frame(10, Buffer.from('abc'))]).subarray(0, 6), () => {});
    expect(decoder.incomplete).toBe(true);
  });

  it('rejects impossible lengths', () => {
    const decoder = new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient));
    const bad = Buffer.alloc(8); bad.writeInt32BE(4, 0);
    expect(() => decoder.feed(bad, () => {})).toThrow('Invalid frame length 4');
    const huge = Buffer.alloc(8); huge.writeInt32BE(2_000_000, 0);
    expect(() => new FrameDecoder(new RC4Cipher(RC4_KEYS.serverToClient)).feed(huge, () => {})).toThrow('Invalid frame length');
  });

  it('isWholeFrame checks the length header', () => {
    expect(isWholeFrame(frame(1, Buffer.from('ab')))).toBe(true);
    expect(isWholeFrame(Buffer.from([0, 0, 0, 9, 1]))).toBe(false);
    expect(isWholeFrame(Buffer.alloc(3))).toBe(false);
  });
});
