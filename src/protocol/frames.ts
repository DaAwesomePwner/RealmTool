import { MAX_FRAME, MIN_FRAME } from './constants.ts';
import type { RC4Cipher } from './RC4Cipher.ts';

/**
 * Splits one direction of a TCP stream into [int32 length][id][body] frames and
 * decrypts each body in place. The cipher state carries across frames.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly cipher: RC4Cipher;

  constructor(cipher: RC4Cipher) {
    this.cipher = cipher;
  }

  get incomplete(): boolean {
    return this.buffer.length > 0;
  }

  /** Throws on an impossible length; the caller must treat that as a transport fault. */
  feed(data: Buffer, accept: (frame: Buffer) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data;
    let offset = 0;
    while (this.buffer.length - offset >= 4) {
      const size = this.buffer.readInt32BE(offset);
      if (size < MIN_FRAME || size > MAX_FRAME) throw new Error(`Invalid frame length ${size}`);
      if (this.buffer.length - offset < size) break;
      const frame = Buffer.from(this.buffer.subarray(offset, offset + size));
      offset += size;
      this.cipher.cipher(frame);
      accept(frame);
    }
    this.buffer = Buffer.from(this.buffer.subarray(offset));
  }
}

export function isWholeFrame(data: Buffer): boolean {
  return data.length >= MIN_FRAME && data.readInt32BE(0) === data.length;
}
