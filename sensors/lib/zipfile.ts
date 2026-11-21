/**
 * A zip reader over a file on disk, for packages too large to hold in memory (Microsoft Store
 * packages are 150-230 MB). It reads the central directory from the end of the file, supports ZIP64
 * (the Store's packages saturate the classic end record and carry a ZIP64 end record), and keeps the
 * raw central-directory and end-record bytes, which the package signature's AXCD digest covers.
 *
 * It refuses what a package writer has no reason to produce: several disks, encrypted entries,
 * compression other than stored and deflate, duplicate names, and entries whose data overlaps another
 * entry or the central directory. Entry data is read with a size cap and checked against its CRC-32.
 */
import { createReadStream } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { createInflateRaw, crc32, inflateRawSync } from 'node:zlib';

export class ZipError extends Error {
  override name = 'ZipError';
}

const EOCD = 0x06054b50;
const ZIP64_EOCD = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The classic end record (22 bytes) plus the longest comment. */
const TAIL_SEARCH = 22 + 0xffff;
const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  /** Offset of the entry's data, past its local header. */
  dataOffset: number;
  /** This entry's record inside `centralDirectory`: [start, end). */
  record: [number, number];
}

export interface ZipEndRecords {
  /** The ZIP64 end of central directory record and its locator, when the archive has them. */
  zip64: { offset: number; record: Uint8Array; locatorOffset: number; locator: Uint8Array } | null;
  eocdOffset: number;
  eocd: Uint8Array;
}

const big = (value: bigint, what: string): number => {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError(`${what} ${value} is too large`);
  return Number(value);
};

export class ZipFile {
  readonly path: string;
  readonly size: number;
  readonly entries: readonly ZipEntry[];
  readonly centralDirectoryOffset: number;
  /** The central directory's raw bytes. */
  readonly centralDirectory: Uint8Array;
  readonly end: ZipEndRecords;
  readonly #handle: FileHandle;
  readonly #byName: ReadonlyMap<string, ZipEntry>;

  private constructor(fields: { path: string; size: number; handle: FileHandle; entries: ZipEntry[]; centralDirectoryOffset: number; centralDirectory: Uint8Array; end: ZipEndRecords }) {
    this.path = fields.path;
    this.size = fields.size;
    this.#handle = fields.handle;
    this.entries = fields.entries;
    this.centralDirectoryOffset = fields.centralDirectoryOffset;
    this.centralDirectory = fields.centralDirectory;
    this.end = fields.end;
    this.#byName = new Map(fields.entries.map(entry => [entry.name, entry]));
  }

  static async open(path: string): Promise<ZipFile> {
    const handle = await open(path, 'r');
    try {
      return await ZipFile.#read(path, handle);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  static async #read(path: string, handle: FileHandle): Promise<ZipFile> {
    const size = (await handle.stat()).size;
    const readAt = async (position: number, length: number): Promise<Uint8Array> => {
      if (position < 0 || length < 0 || position + length > size) throw new ZipError(`bytes ${position}..${position + length} are outside the ${size}-byte file`);
      const bytes = new Uint8Array(length);
      const { bytesRead } = await handle.read(bytes, 0, length, position);
      if (bytesRead !== length) throw new ZipError(`read ${bytesRead} of ${length} bytes at ${position}`);
      return bytes;
    };
    if (size < 22) throw new ZipError('not a zip archive: shorter than an end of central directory record');
    const tailStart = Math.max(0, size - TAIL_SEARCH);
    const tail = await readAt(tailStart, size - tailStart);
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let at = -1;
    for (let candidate = tail.length - 22; candidate >= 0; candidate--) {
      if (view.getUint32(candidate, true) === EOCD && candidate + 22 + view.getUint16(candidate + 20, true) === tail.length) { at = candidate; break; }
    }
    if (at < 0) throw new ZipError('not a zip archive: no end of central directory record ends the file');
    const eocdOffset = tailStart + at;
    const eocd = tail.slice(at, tail.length);
    const disk = view.getUint16(at + 4, true);
    const centralDisk = view.getUint16(at + 6, true);
    let total = view.getUint16(at + 10, true);
    let centralSize = view.getUint32(at + 12, true);
    let centralOffset = view.getUint32(at + 16, true);
    let zip64: ZipEndRecords['zip64'] = null;
    const saturated = total === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff || disk === 0xffff || centralDisk === 0xffff;
    // A writer may add ZIP64 records without saturating the classic ones, so look for the locator either way.
    if (eocdOffset >= 20) {
      const locator = await readAt(eocdOffset - 20, 20);
      const locatorView = new DataView(locator.buffer, locator.byteOffset, locator.byteLength);
      if (locatorView.getUint32(0, true) === ZIP64_LOCATOR) {
        if (locatorView.getUint32(4, true) !== 0 || locatorView.getUint32(16, true) > 1) throw new ZipError('multi-disk ZIP64 archives are not supported');
        const recordOffset = big(locatorView.getBigUint64(8, true), 'ZIP64 end record offset');
        const head = await readAt(recordOffset, 56);
        const headView = new DataView(head.buffer, head.byteOffset, head.byteLength);
        if (headView.getUint32(0, true) !== ZIP64_EOCD) throw new ZipError(`no ZIP64 end of central directory record at ${recordOffset}`);
        const recordSize = big(headView.getBigUint64(4, true), 'ZIP64 end record size') + 12;
        if (recordSize < 56 || recordOffset + recordSize !== eocdOffset - 20) throw new ZipError('the ZIP64 end record does not end where its locator starts');
        if (headView.getUint32(16, true) !== 0 || headView.getUint32(20, true) !== 0) throw new ZipError('multi-disk ZIP64 archives are not supported');
        const entriesOnDisk = big(headView.getBigUint64(24, true), 'ZIP64 entries on disk');
        total = big(headView.getBigUint64(32, true), 'ZIP64 total entries');
        if (entriesOnDisk !== total) throw new ZipError('multi-disk ZIP64 archives are not supported');
        centralSize = big(headView.getBigUint64(40, true), 'ZIP64 central directory size');
        centralOffset = big(headView.getBigUint64(48, true), 'ZIP64 central directory offset');
        zip64 = { offset: recordOffset, record: await readAt(recordOffset, recordSize), locatorOffset: eocdOffset - 20, locator };
      } else if (saturated) {
        throw new ZipError('the end record is saturated but no ZIP64 locator precedes it');
      }
    }
    if (!zip64 && (disk !== 0 || centralDisk !== 0)) throw new ZipError('multi-disk archives are not supported');
    const centralEnd = zip64 ? zip64.offset : eocdOffset;
    if (centralSize > MAX_CENTRAL_DIRECTORY || centralOffset + centralSize !== centralEnd) {
      throw new ZipError(`the central directory (${centralSize} bytes at ${centralOffset}) does not end where the end records start (${centralEnd})`);
    }
    const centralDirectory = await readAt(centralOffset, centralSize);
    const cd = new DataView(centralDirectory.buffer, centralDirectory.byteOffset, centralDirectory.byteLength);
    const entries: ZipEntry[] = [];
    const names = new Set<string>();
    let offset = 0;
    for (let index = 0; index < total; index++) {
      if (offset + 46 > centralDirectory.length || cd.getUint32(offset, true) !== CENTRAL) throw new ZipError(`central directory record ${index} is missing or corrupt`);
      const flags = cd.getUint16(offset + 8, true);
      const method = cd.getUint16(offset + 10, true);
      const crc = cd.getUint32(offset + 16, true);
      let compressedSize = cd.getUint32(offset + 20, true);
      let uncompressedSize = cd.getUint32(offset + 24, true);
      const nameLength = cd.getUint16(offset + 28, true);
      const extraLength = cd.getUint16(offset + 30, true);
      const commentLength = cd.getUint16(offset + 32, true);
      let startDisk = cd.getUint16(offset + 34, true);
      let localHeaderOffset = cd.getUint32(offset + 42, true);
      const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
      if (recordEnd > centralDirectory.length) throw new ZipError(`central directory record ${index} runs past the directory`);
      const name = new TextDecoder('utf-8', { fatal: true }).decode(centralDirectory.subarray(offset + 46, offset + 46 + nameLength));
      const extra = centralDirectory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
      if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || startDisk === 0xffff) {
        const values = zip64Extra(extra, name);
        let cursor = 0;
        const take = () => {
          if (cursor + 8 > values.length) throw new ZipError(`${name}: the ZIP64 extra field is too short`);
          const value = big(new DataView(values.buffer, values.byteOffset, values.byteLength).getBigUint64(cursor, true), `${name} ZIP64 value`);
          cursor += 8;
          return value;
        };
        if (uncompressedSize === 0xffffffff) uncompressedSize = take();
        if (compressedSize === 0xffffffff) compressedSize = take();
        if (localHeaderOffset === 0xffffffff) localHeaderOffset = take();
        if (startDisk === 0xffff) {
          if (cursor + 4 > values.length) throw new ZipError(`${name}: the ZIP64 extra field lacks the disk number`);
          startDisk = new DataView(values.buffer, values.byteOffset, values.byteLength).getUint32(cursor, true);
        }
      }
      if (startDisk !== 0) throw new ZipError(`${name}: multi-disk archives are not supported`);
      if (flags & 0x1) throw new ZipError(`${name}: encrypted entries are not supported`);
      if (method !== 0 && method !== 8) throw new ZipError(`${name}: compression method ${method} is not supported`);
      if (names.has(name)) throw new ZipError(`the archive lists "${name}" twice`);
      names.add(name);
      entries.push({ name, method, flags, crc32: crc, compressedSize, uncompressedSize, localHeaderOffset, dataOffset: -1, record: [offset, recordEnd] });
      offset = recordEnd;
    }
    if (offset !== centralDirectory.length) throw new ZipError(`${centralDirectory.length - offset} bytes follow the last central directory record`);

    // Local headers: the data offset, and no entry's data may overlap another's or the directory.
    const byOffset = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
    let previousEnd = 0;
    for (const entry of byOffset) {
      if (entry.localHeaderOffset < previousEnd) throw new ZipError(`${entry.name} starts at ${entry.localHeaderOffset}, inside the previous entry`);
      const local = await readAt(entry.localHeaderOffset, 30);
      const localView = new DataView(local.buffer, local.byteOffset, local.byteLength);
      if (localView.getUint32(0, true) !== LOCAL) throw new ZipError(`${entry.name}: no local file header at ${entry.localHeaderOffset}`);
      entry.dataOffset = entry.localHeaderOffset + 30 + localView.getUint16(26, true) + localView.getUint16(28, true);
      const dataEnd = entry.dataOffset + entry.compressedSize;
      if (dataEnd > centralOffset) throw new ZipError(`${entry.name}: its data runs into the central directory`);
      previousEnd = dataEnd;
    }
    return new ZipFile({ path, size, handle, entries, centralDirectoryOffset: centralOffset, centralDirectory, end: { zip64, eocdOffset, eocd } });
  }

  entry(name: string): ZipEntry | undefined {
    return this.#byName.get(name);
  }

  /** Raw bytes of the file, for digests over zip structure. */
  async readRaw(position: number, length: number): Promise<Uint8Array> {
    if (position < 0 || length < 0 || position + length > this.size) throw new ZipError(`bytes ${position}..${position + length} are outside the ${this.size}-byte file`);
    const bytes = new Uint8Array(length);
    const { bytesRead } = await this.#handle.read(bytes, 0, length, position);
    if (bytesRead !== length) throw new ZipError(`read ${bytesRead} of ${length} bytes at ${position}`);
    return bytes;
  }

  /** An entry's uncompressed bytes, refused past `maxBytes`, checked against its size and CRC-32. */
  async read(entry: ZipEntry, maxBytes: number): Promise<Uint8Array> {
    if (entry.uncompressedSize > maxBytes) throw new ZipError(`${entry.name} is ${entry.uncompressedSize} bytes, more than the ${maxBytes} allowed`);
    const raw = await this.readRaw(entry.dataOffset, entry.compressedSize);
    let data: Uint8Array;
    if (entry.method === 0) data = raw;
    else {
      try { data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, entry.uncompressedSize) })); }
      catch (error) { throw new ZipError(`${entry.name}: ${(error as Error).message}`); }
    }
    if (data.length !== entry.uncompressedSize) throw new ZipError(`${entry.name}: expected ${entry.uncompressedSize} bytes, read ${data.length}`);
    if (crc32(data) !== entry.crc32) throw new ZipError(`${entry.name}: the CRC-32 differs from the central directory's`);
    return data;
  }

  /** An entry's uncompressed bytes as a stream of chunks; the size and CRC-32 are checked at the end. */
  async *stream(entry: ZipEntry): AsyncGenerator<Uint8Array> {
    if (entry.compressedSize === 0) {
      if (entry.uncompressedSize !== 0) throw new ZipError(`${entry.name}: no data for ${entry.uncompressedSize} bytes`);
      return;
    }
    const source = createReadStream(this.path, { start: entry.dataOffset, end: entry.dataOffset + entry.compressedSize - 1, highWaterMark: 1 << 20 });
    const chunks = entry.method === 0 ? source : source.pipe(createInflateRaw());
    let size = 0;
    let crc = 0;
    try {
      for await (const chunk of chunks) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > entry.uncompressedSize) throw new ZipError(`${entry.name}: more than the ${entry.uncompressedSize} bytes the directory states`);
        crc = crc32(bytes, crc);
        yield new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
    } finally {
      source.destroy();
    }
    if (size !== entry.uncompressedSize) throw new ZipError(`${entry.name}: expected ${entry.uncompressedSize} bytes, read ${size}`);
    if (crc !== entry.crc32) throw new ZipError(`${entry.name}: the CRC-32 differs from the central directory's`);
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

function zip64Extra(extra: Uint8Array, name: string): Uint8Array {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let at = 0; at + 4 <= extra.length;) {
    const id = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (at + 4 + length > extra.length) throw new ZipError(`${name}: an extra field runs past the record`);
    if (id === 0x0001) return extra.subarray(at + 4, at + 4 + length);
    at += 4 + length;
  }
  throw new ZipError(`${name}: saturated sizes without a ZIP64 extra field`);
}
