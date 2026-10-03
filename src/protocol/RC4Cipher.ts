// Ported from realm-engine-client client/src/crypto/RC4Cipher.ts @ 9ab4f8f (MIT, see NOTICE).
/**
 * RC4 stream cipher for RotMG packet encryption/decryption.
 * Ported from KRelayBetter's Rc4Cipher.cs.
 *
 * The cipher processes packet bytes starting at offset 5,
 * skipping the 4-byte length header + 1-byte packet ID.
 * The cipher state is maintained across packets (stateful).
 */
export class RC4Cipher {
  private engineState: Uint8Array;
  private workingKey: Buffer;
  private x = 0;
  private y = 0;

  constructor(hexKey: string) {
    this.workingKey = RC4Cipher.hexToBytes(hexKey);
    this.engineState = new Uint8Array(256);
    this.setKey(this.workingKey);
  }

  /** Encrypt/decrypt packet in-place, skipping the 5-byte header. */
  cipher(packet: Buffer): void {
    this.processBytes(packet, 5, packet.length - 5, packet, 5);
  }

  /** Reset cipher state to initial key schedule. */
  reset(): void {
    this.setKey(this.workingKey);
  }

  private processBytes(
    input: Buffer,
    inOff: number,
    length: number,
    output: Buffer,
    outOff: number,
  ): void {
    for (let i = 0; i < length; i++) {
      this.x = (this.x + 1) & 0xff;
      this.y = (this.engineState[this.x] + this.y) & 0xff;

      // swap
      const tmp = this.engineState[this.x];
      this.engineState[this.x] = this.engineState[this.y];
      this.engineState[this.y] = tmp;

      // xor
      output[i + outOff] =
        input[i + inOff] ^
        this.engineState[
          (this.engineState[this.x] + this.engineState[this.y]) & 0xff
        ];
    }
  }

  private setKey(keyBytes: Buffer): void {
    this.x = 0;
    this.y = 0;

    for (let i = 0; i < 256; i++) {
      this.engineState[i] = i;
    }

    let i1 = 0;
    let i2 = 0;
    for (let i = 0; i < 256; i++) {
      i2 = ((keyBytes[i1] & 0xff) + this.engineState[i] + i2) & 0xff;
      const tmp = this.engineState[i];
      this.engineState[i] = this.engineState[i2];
      this.engineState[i2] = tmp;
      i1 = (i1 + 1) % keyBytes.length;
    }
  }

  static hexToBytes(hex: string): Buffer {
    return Buffer.from(hex, 'hex');
  }
}
