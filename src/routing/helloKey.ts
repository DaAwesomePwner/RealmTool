/**
 * HELLO layout: [int32 len][id][int32 gameId][str buildVersion][str accessToken][int32 keyTime][byteArray16 key]...
 * Strings and byteArray16 are an int16 length followed by bytes.
 * Returns the offset of the key's length prefix, or -1 if the frame is truncated or malformed.
 */
export function findHelloKeyOffset(raw: Buffer): number {
  let offset = 5 + 4;
  for (let i = 0; i < 2; i++) {
    if (raw.length < offset + 2) return -1;
    const length = raw.readInt16BE(offset);
    if (length < 0) return -1;
    offset += 2 + length;
  }
  offset += 4;
  if (raw.length < offset + 2) return -1;
  const keyLength = raw.readInt16BE(offset);
  if (keyLength < 0 || raw.length < offset + 2 + keyLength) return -1;
  return offset;
}

/** Return a copy of `raw` with the key at `keyOffset` replaced and the frame length fixed. */
export function patchHelloKey(raw: Buffer, keyOffset: number, key: Buffer): Buffer {
  const oldLength = raw.readInt16BE(keyOffset);
  const before = raw.subarray(0, keyOffset);
  const after = raw.subarray(keyOffset + 2 + oldLength);
  const out = Buffer.alloc(before.length + 2 + key.length + after.length);
  let position = before.copy(out, 0);
  position = out.writeInt16BE(key.length, position);
  position += key.copy(out, position);
  after.copy(out, position);
  out.writeInt32BE(out.length, 0);
  return out;
}
