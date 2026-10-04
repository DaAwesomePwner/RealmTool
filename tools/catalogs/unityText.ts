// Adapted from realm-engine-client client/src/util/rotmgLocalExtractor.ts @ 88a66b2 (MIT, see NOTICE).
/** Only the Unity v22 TextAsset path; no texture decoding or writes to the install. */
export function extractXmlTextAssets(buf: Buffer): { objects: string[]; tiles: string[] } {
  function range(offset: number, size: number, limit = buf.length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > limit) {
      throw new Error('Truncated or invalid Unity SerializedFile');
    }
  }
  range(0, 48);
  const version = buf.readUInt32BE(8);
  if (version !== 22) throw new Error(`Unsupported Unity SerializedFile version: ${version} (expected 22)`);
  if (buf[16] !== 0) throw new Error('Unsupported Unity SerializedFile endianness');
  const dataOffset = Number(buf.readBigUInt64BE(32));
  range(dataOffset, 0);
  let pos = 48;
  const skip = (size: number) => { range(pos, size, dataOffset); pos += size; };
  const int = () => { range(pos, 4, dataOffset); const n = buf.readInt32LE(pos); pos += 4; return n; };
  const count = () => { const n = int(); if (n < 0) throw new Error('Invalid Unity table count'); return n; };
  const versionEnd = buf.indexOf(0, pos);
  if (versionEnd < 0) throw new Error('Missing Unity version terminator');
  skip(versionEnd - pos + 1);
  skip(4);
  range(pos, 1, dataOffset);
  const enableTypeTree = buf[pos++];
  const types: number[] = [];
  const typeCount = count();
  for (let i = 0; i < typeCount; i++) {
    const classId = int();
    skip(3);
    if (classId === 114) skip(16);
    skip(16);
    if (enableTypeTree) {
      const nodes = count(); const strings = count();
      skip(nodes * 32 + strings);
      // SerializedFile v21+ stores type dependencies after each enabled type tree.
      const dependencies = count();
      skip(dependencies * 4);
    }
    types.push(classId);
  }
  const objectCount = count();
  const objects: string[] = [], tiles: string[] = [];
  for (let i = 0; i < objectCount; i++) {
    skip((4 - pos % 4) % 4);
    range(pos, 24, dataOffset);
    const byteStart = Number(buf.readBigInt64LE(pos + 8));
    const size = buf.readUInt32LE(pos + 16);
    const typeIndex = buf.readInt32LE(pos + 20);
    pos += 24;
    const offset = dataOffset + byteStart;
    if (byteStart < 0) throw new Error('Invalid Unity object offset');
    range(offset, size);
    if (typeIndex < 0 || typeIndex >= types.length) throw new Error('Invalid Unity object type index');
    if (types[typeIndex] !== 49) continue;
    const end = offset + size;
    range(offset, 4, end);
    const nameLength = buf.readInt32LE(offset);
    range(offset + 4, nameLength, end);
    const afterName = offset + 4 + nameLength;
    const textLengthOffset = afterName + (4 - afterName % 4) % 4;
    range(textLengthOffset, 4, end);
    const textLength = buf.readInt32LE(textLengthOffset);
    range(textLengthOffset + 4, textLength, end);
    const text = buf.toString('utf8', textLengthOffset + 4, textLengthOffset + 4 + textLength);
    if (!text.startsWith('<?xml')) continue;
    if (text.includes('<Objects>')) objects.push(text);
    else if (text.includes('<GroundTypes>')) tiles.push(text);
  }
  return { objects, tiles };
}
