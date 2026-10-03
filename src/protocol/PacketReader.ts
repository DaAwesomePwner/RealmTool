// Ported from realm-engine-client client/src/packets/PacketReader.ts @ 9ab4f8f (MIT, see NOTICE).
/**
 * Big-endian binary reader for RotMG packet deserialization.
 * Ported from KRelayBetter's PacketReader.cs.
 */
export class PacketReader {
  private buffer: Buffer;
  private _offset: number;

  constructor(data: Buffer, offset = 0) {
    this.buffer = data;
    this._offset = offset;
  }

  get position(): number {
    return this._offset;
  }

  get length(): number {
    return this.buffer.length;
  }

  get remaining(): number {
    return this.buffer.length - this._offset;
  }

  readByte(): number {
    const val = this.buffer.readUInt8(this._offset);
    this._offset += 1;
    return val;
  }

  readSByte(): number {
    const val = this.buffer.readInt8(this._offset);
    this._offset += 1;
    return val;
  }

  readBool(): boolean {
    return this.readByte() !== 0;
  }

  readInt16(): number {
    const val = this.buffer.readInt16BE(this._offset);
    this._offset += 2;
    return val;
  }

  readUInt16(): number {
    const val = this.buffer.readUInt16BE(this._offset);
    this._offset += 2;
    return val;
  }

  readInt32(): number {
    const val = this.buffer.readInt32BE(this._offset);
    this._offset += 4;
    return val;
  }

  readUInt32(): number {
    const val = this.buffer.readUInt32BE(this._offset);
    this._offset += 4;
    return val;
  }

  readFloat(): number {
    const val = this.buffer.readFloatBE(this._offset);
    this._offset += 4;
    return val;
  }

  /** Read a string with int16 length prefix (big-endian). */
  readString(): string {
    const len = this.readInt16();
    if (len < 0 || len > this.remaining) {
      throw new Error(`Invalid string length: ${len}, remaining: ${this.remaining}`);
    }
    const str = this.buffer.toString('utf8', this._offset, this._offset + len);
    this._offset += len;
    return str;
  }

  /** Read a string with int32 length prefix (big-endian). */
  readUtf32String(): string {
    const len = this.readInt32();
    if (len < 0 || len > this.remaining) {
      throw new Error(`Invalid utf32 string length: ${len}, remaining: ${this.remaining}`);
    }
    const str = this.buffer.toString('utf8', this._offset, this._offset + len);
    this._offset += len;
    return str;
  }

  /** Read raw bytes with no length prefix. */
  readBytes(count: number): Buffer {
    if (count < 0 || count > this.remaining) {
      throw new Error(`Cannot read ${count} bytes, remaining: ${this.remaining}`);
    }
    const slice = Buffer.alloc(count);
    this.buffer.copy(slice, 0, this._offset, this._offset + count);
    this._offset += count;
    return slice;
  }

  /** Read remaining bytes. */
  readRemainingBytes(): Buffer {
    return this.readBytes(this.remaining);
  }

  /**
   * Read a compressed (variable-length) integer.
   * Ported from KRelayBetter's PacketReader.ReadCompressedInt().
   *
   * First byte: bit 6 = sign, bits 0-5 = 6 data bits, bit 7 = continuation.
   * Subsequent bytes: bits 0-6 = 7 data bits, bit 7 = continuation.
   */
  readCompressedInt(): number {
    let firstByte = this.readByte();
    const isNegative = (firstByte & 64) !== 0;
    let shift = 6;
    let result = firstByte & 63;

    while ((firstByte & 128) !== 0) {
      firstByte = this.readByte();
      result += (firstByte & 127) * 2 ** shift;
      shift += 7;
    }

    return isNegative ? -result : result;
  }
}
