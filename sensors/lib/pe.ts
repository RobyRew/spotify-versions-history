/**
 * Windows PE reading: machine type, section table, the Authenticode certificate table, and the
 * VS_VERSIONINFO ProductVersion string. readRemotePe reads only the headers, the .rsrc section
 * (about 290 KB for Spotify's installers) and not the remaining ~160 MB.
 */
import { FULL_VERSION } from '../../lib/versions.ts';
import type { Arch, Fetch } from '../types.ts';
import { getRange } from './http.ts';

export const MACHINES: Readonly<Record<number, Arch>> = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'x86' };
const HEADER_BYTES = 4096;
const PRODUCT_VERSION = Buffer.from('ProductVersion\0', 'utf16le');

export interface PeSection {
  name: string;
  rawPointer: number;
  rawSize: number;
}

export interface PeLayout {
  machine: number;
  sections: PeSection[];
  /** File offset and size of the Authenticode certificate table, when the file is signed. */
  certificate: { offset: number; size: number } | null;
}

export function parsePeHeaders(head: Uint8Array): PeLayout {
  if (head.length < 0x40 || head[0] !== 0x4d || head[1] !== 0x5a) throw new Error('Not a Windows executable');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > head.length || view.getUint32(pe, true) !== 0x00004550) throw new Error('Missing PE header');
  const machine = view.getUint16(pe + 4, true);
  const sectionCount = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  const magic = view.getUint16(optional, true);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error(`Unknown optional header magic 0x${magic.toString(16)}`);
  // IMAGE_DIRECTORY_ENTRY_SECURITY is data directory 4; its "address" is a file offset, not an RVA.
  const security = optional + (magic === 0x20b ? 112 : 96) + 4 * 8;
  const table = optional + optionalSize;
  if (security + 8 > head.length || table + 40 * sectionCount > head.length) throw new Error('PE headers extend past the bytes read');
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const at = table + 40 * i;
    const name = Buffer.from(head.subarray(at, at + 8)).toString('latin1').replace(/\0+$/, '');
    sections.push({ name, rawSize: view.getUint32(at + 16, true), rawPointer: view.getUint32(at + 20, true) });
  }
  const certOffset = view.getUint32(security, true);
  const certSize = view.getUint32(security + 4, true);
  return { machine, sections, certificate: certSize > 0 ? { offset: certOffset, size: certSize } : null };
}

/** The ProductVersion string of a VS_VERSIONINFO resource somewhere in `bytes`, or null. */
export function findProductVersion(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = buffer.indexOf(PRODUCT_VERSION);
  if (at < 0) return null;
  let offset = at + PRODUCT_VERSION.length;
  while (offset + 1 < buffer.length && buffer.readUInt16LE(offset) === 0) offset += 2;
  let end = offset;
  while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
  return buffer.toString('utf16le', offset, end).trim();
}

/** Machine type and ProductVersion of a whole PE file already on disk or in memory. */
export function inspectPortableExecutable(buffer: Uint8Array): { machine: number; productVersion: string } {
  const { machine } = parsePeHeaders(buffer.subarray(0, Math.min(buffer.length, HEADER_BYTES)));
  const productVersion = findProductVersion(buffer);
  if (!productVersion || !FULL_VERSION.test(productVersion)) throw new Error(`Unexpected ProductVersion ${JSON.stringify(productVersion)}`);
  return { machine, productVersion };
}

export interface RemotePe {
  machine: number;
  arch: Arch | null;
  productVersion: string;
  certificate: { offset: number; size: number } | null;
  bytesRead: number;
}

/** Reads a remote installer's identity with range requests pinned to `etag`; `size` caps the header read. */
export async function readRemotePe(fetchImpl: Fetch, url: string, etag: string | null, size: number | null = null): Promise<RemotePe> {
  const head = await getRange(fetchImpl, url, 0, Math.min(HEADER_BYTES, size ?? HEADER_BYTES) - 1, etag);
  const layout = parsePeHeaders(head);
  const rsrc = layout.sections.find(section => section.name === '.rsrc');
  if (!rsrc || rsrc.rawSize === 0) throw new Error(`${url}: no .rsrc section`);
  const resources = await getRange(fetchImpl, url, rsrc.rawPointer, rsrc.rawPointer + rsrc.rawSize - 1, etag);
  const productVersion = findProductVersion(resources);
  if (!productVersion || !FULL_VERSION.test(productVersion)) throw new Error(`${url}: unexpected ProductVersion ${JSON.stringify(productVersion)}`);
  return { machine: layout.machine, arch: MACHINES[layout.machine] ?? null, productVersion, certificate: layout.certificate, bytesRead: head.length + resources.length };
}
