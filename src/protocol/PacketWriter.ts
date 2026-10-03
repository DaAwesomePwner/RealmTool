// Ported from realm-engine-client client/src/packets/PacketWriter.ts @ 9ab4f8f (MIT, see NOTICE).
/**
 * Big-endian binary writer for RotMG packet serialization.
 * Ported from KRelayBetter's PacketWriter.cs.
 */
export class PacketWriter {
  private chunks: Buffer[] = [];
  private _length = 0;

  get length(): number {
    return this._length;
  }

  writeByte(v: number): void {
    const buf = Buffer.alloc(1);
    buf.writeUInt8(v & 0xff, 0);
    this.chunks.push(buf);
    this._length += 1;
  }

  writeSByte(v: number): void {
    const buf = Buffer.alloc(1);
    buf.writeInt8(v, 0);
    this.chunks.push(buf);
    this._length += 1;
  }

  writeBool(v: boolean): void {
    this.writeByte(v ? 1 : 0);
  }

  writeInt16(v: number): void {
    const buf = Buffer.alloc(2);
    buf.writeInt16BE(v, 0);
    this.chunks.push(buf);
    this._length += 2;
  }

  writeUInt16(v: number): void {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(v, 0);
    this.chunks.push(buf);
    this._length += 2;
  }

  writeInt32(v: number): void {
    const buf = Buffer.alloc(4);
    buf.writeInt32BE(v, 0);
    this.chunks.push(buf);
    this._length += 4;
  }

  writeUInt32(v: number): void {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(v, 0);
    this.chunks.push(buf);
    this._length += 4;
  }

  writeFloat(v: number): void {
    const buf = Buffer.alloc(4);
    buf.writeFloatBE(v, 0);
    this.chunks.push(buf);
    this._length += 4;
  }

  /** Write a string with int16 length prefix (big-endian). */
  writeString(v: string): void {
    const strBuf = Buffer.from(v, 'utf8');
    this.writeInt16(strBuf.length);
    this.chunks.push(strBuf);
    this._length += strBuf.length;
  }

  /** Write a string with int32 length prefix (big-endian). */
  writeUtf32String(v: string): void {
    const strBuf = Buffer.from(v, 'utf8');
    this.writeInt32(strBuf.length);
    this.chunks.push(strBuf);
    this._length += strBuf.length;
  }

  /** Write raw bytes. */
  writeBytes(v: Buffer): void {
    this.chunks.push(Buffer.from(v));
    this._length += v.length;
  }

  /**
   * Write a compressed (variable-length) integer.
   * Ported from KRelayBetter's PacketWriter.WriteCompressedInt().
   */
  writeCompressedInt(value: number): void {
    const isNegative = value < 0;
    let num = isNegative ? -value : value;

    let firstByte = num & 63;
    if (isNegative) firstByte |= 64;
    num = num >>> 6;
    let hasMore = num > 0;
    if (hasMore) firstByte |= 128;
    this.writeByte(firstByte);

    while (hasMore) {
      let nextByte = num & 127;
      num = num >>> 7;
      hasMore = num > 0;
      if (hasMore) nextByte |= 128;
      this.writeByte(nextByte);
    }
  }

  /** Concatenate all chunks into a single buffer. */
  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this._length);
  }

  /**
   * Write a big-endian int32 at the start of an existing buffer.
   * Used to stamp the packet length into the header.
   */
  static writeInt32At(data: Buffer, value: number, offset = 0): void {
    data.writeInt32BE(value, offset);
  }
}
