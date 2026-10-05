// Synthetic SerializedFile v22: little-endian metadata, no type tree, two class IDs.
export function serializedFile(entries: { classId: number; text: string }[], typeTree = false): Buffer {
  const header = Buffer.alloc(48);
  header.writeUInt32BE(22, 8);
  const chunks: Buffer[] = [];
  const int = (n: number) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
  chunks.push(Buffer.from('fixture\0'), int(19), Buffer.from([typeTree ? 1 : 0]), int(2));
  for (const id of [49, 28]) {
    chunks.push(int(id), Buffer.alloc(19));
    if (typeTree) chunks.push(int(1), int(4), Buffer.alloc(32), Buffer.from('str\0'), int(1), int(0));
  }
  chunks.push(int(entries.length));
  const data: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const position = 48 + chunks.reduce((n, b) => n + b.length, 0);
    chunks.push(Buffer.alloc((4 - position % 4) % 4));
    const text = Buffer.from(entry.text);
    const payload = Buffer.concat([int(4), Buffer.from('name'), int(text.length), text]);
    const row = Buffer.alloc(24);
    row.writeBigInt64LE(BigInt(data.length + 1));
    row.writeBigInt64LE(BigInt(offset), 8);
    row.writeUInt32LE(payload.length, 16);
    row.writeInt32LE(entry.classId === 49 ? 0 : 1, 20);
    chunks.push(row);
    const padded = Buffer.concat([payload, Buffer.alloc((4 - payload.length % 4) % 4)]);
    data.push(padded);
    offset += padded.length;
  }
  const meta = Buffer.concat(chunks);
  header.writeUInt32BE(meta.length, 20);
  header.writeBigUInt64BE(BigInt(48 + meta.length + offset), 24);
  header.writeBigUInt64BE(BigInt(48 + meta.length), 32);
  return Buffer.concat([header, meta, ...data]);
}

