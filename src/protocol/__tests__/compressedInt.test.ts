import { describe, expect, it } from 'vitest';
import { PacketReader } from '../PacketReader.ts';
import { PacketWriter } from '../PacketWriter.ts';

describe('compressed signed integers', () => {
  it.each([0, 1, -1, 63, 64, -64, 2147483647, -2147483648])('round-trips %i', (value) => {
    const writer = new PacketWriter();
    writer.writeCompressedInt(value);
    const reader = new PacketReader(writer.toBuffer());
    expect(reader.readCompressedInt()).toBe(value);
    expect(reader.remaining).toBe(0);
  });

  it('decodes the minimum signed integer from c080808010', () => {
    const reader = new PacketReader(Buffer.from('c080808010', 'hex'));
    expect(reader.readCompressedInt()).toBe(-2147483648);
    expect(reader.remaining).toBe(0);
  });
});
