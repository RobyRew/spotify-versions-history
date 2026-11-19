/** Reads single entries out of a (non-ZIP64) zip archive held in memory. */
import { inflateRawSync } from 'node:zlib';

interface CentralEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function centralDirectory(zip: Uint8Array): CentralEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (view.getUint32(at, true) === 0x06054b50) { eocd = at; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive: no end of central directory');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: CentralEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > zip.length || view.getUint32(at, true) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    entries.push({
      name: Buffer.from(zip.subarray(at + 46, at + 46 + nameLength)).toString('utf8'),
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function zipEntryNames(zip: Uint8Array): string[] {
  return centralDirectory(zip).map(entry => entry.name);
}

export function readZipEntry(zip: Uint8Array, name: string): Uint8Array {
  const entry = centralDirectory(zip).find(candidate => candidate.name === name);
  if (!entry) throw new Error(`${name} is not in the zip`);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.getUint32(entry.localOffset, true) !== 0x04034b50) throw new Error(`Corrupt local header for ${name}`);
  const start = entry.localOffset + 30 + view.getUint16(entry.localOffset + 26, true) + view.getUint16(entry.localOffset + 28, true);
  const data = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(data));
  throw new Error(`Unsupported zip compression method ${entry.method} for ${name}`);
}
