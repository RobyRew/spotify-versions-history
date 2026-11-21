/**
 * Microsoft Store packages (.appx, .msix and their bundles): the parts the package signature covers,
 * the package identity in its manifest, and the block map that hashes every file of the package.
 *
 * AppxSignature.p7x signs five digests (sensors/verify/appx-signature.ts): AXPC over every local file
 * record before the signature file, AXCD over the central directory without the signature's record
 * plus the end records rewritten as if the signature file were absent, AXCT over [Content_Types].xml,
 * AXBM over AppxBlockMap.xml and AXCI over AppxMetadata/CodeIntegrity.cat. readAppxParts computes the
 * first two from the zip structure; the AXCD definition was matched against the signed value of
 * SpotifyAB.SpotifyMusic_1.310.2586.0_x64 on 2026-11-20.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { TrustAnchors } from '../../lib/trust.ts';
import { children, onlyChild, parseXml, XmlError, type XmlElement } from '../lib/xml.ts';
import { ZipError, ZipFile, type ZipEntry } from '../lib/zipfile.ts';
import { fail, pass, type Check } from './types.ts';

export const APPX_VERIFIER = 'svh-appx/1';

const SIGNATURE = 'AppxSignature.p7x';
const BLOCK_MAP = 'AppxBlockMap.xml';
const CONTENT_TYPES = '[Content_Types].xml';
const CODE_INTEGRITY = 'AppxMetadata/CodeIntegrity.cat';
const PACKAGE_MANIFEST = 'AppxManifest.xml';
const BUNDLE_MANIFEST = 'AppxMetadata/AppxBundleManifest.xml';
/** Entries the block map does not list: itself, the signature, the content types and the code integrity catalog. */
const UNLISTED = new Set([SIGNATURE, BLOCK_MAP, CONTENT_TYPES, CODE_INTEGRITY]);
const BLOCK_SIZE = 64 * 1024;
const SHA256_METHOD = 'http://www.w3.org/2001/04/xmlenc#sha256';
const MAX_METADATA = 32 * 1024 * 1024;

export interface AppxParts {
  kind: 'package' | 'bundle';
  manifestName: string;
  manifest: string;
  blockMap: Uint8Array;
  contentTypes: Uint8Array;
  signature: Uint8Array;
  codeIntegrity?: Uint8Array;
  /** SHA-256 (hex) of what the signature's AXPC and AXCD records cover, computed from the file. */
  axpc: string;
  axcd: string;
}

function required(zip: ZipFile, name: string): ZipEntry {
  const entry = zip.entry(name);
  if (!entry) throw new ZipError(`the package has no ${name}`);
  return entry;
}

async function hashFileRange(path: string, start: number, end: number): Promise<string> {
  const hash = createHash('sha256');
  if (end > start) for await (const chunk of createReadStream(path, { start, end: end - 1, highWaterMark: 1 << 20 })) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The central directory and end records as they would read without the signature file (AXCD). */
export function centralDirectoryWithoutSignature(zip: ZipFile, signature: ZipEntry): Uint8Array {
  const [recordStart, recordEnd] = signature.record;
  const directory = new Uint8Array(zip.centralDirectory.length - (recordEnd - recordStart));
  directory.set(zip.centralDirectory.subarray(0, recordStart), 0);
  directory.set(zip.centralDirectory.subarray(recordEnd), recordStart);
  const entries = zip.entries.length - 1;
  const size = directory.length;
  const offset = signature.localHeaderOffset;
  const parts: Uint8Array[] = [directory];
  if (zip.end.zip64) {
    const record = zip.end.zip64.record.slice();
    const view = new DataView(record.buffer);
    view.setBigUint64(24, BigInt(entries), true);
    view.setBigUint64(32, BigInt(entries), true);
    view.setBigUint64(40, BigInt(size), true);
    view.setBigUint64(48, BigInt(offset), true);
    const locator = zip.end.zip64.locator.slice();
    new DataView(locator.buffer).setBigUint64(8, BigInt(offset + size), true);
    parts.push(record, locator);
  }
  const eocd = zip.end.eocd.slice();
  const view = new DataView(eocd.buffer);
  // Fields the ZIP64 record carries stay saturated; plain values are rewritten like the ZIP64 ones.
  if (view.getUint16(8, true) !== 0xffff) view.setUint16(8, entries, true);
  if (view.getUint16(10, true) !== 0xffff) view.setUint16(10, entries, true);
  if (view.getUint32(12, true) !== 0xffffffff) view.setUint32(12, size, true);
  if (view.getUint32(16, true) !== 0xffffffff) view.setUint32(16, offset, true);
  parts.push(eocd);
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return new Uint8Array(hash.digest());
}

async function partsOf(zip: ZipFile): Promise<AppxParts> {
  const bundle = zip.entry(BUNDLE_MANIFEST);
  const manifestName = bundle ? BUNDLE_MANIFEST : PACKAGE_MANIFEST;
  const signature = required(zip, SIGNATURE);
  for (const entry of zip.entries) {
    if (entry !== signature && entry.localHeaderOffset > signature.localHeaderOffset) throw new ZipError(`${entry.name} follows ${SIGNATURE}, which must be the package's last file`);
  }
  const codeIntegrity = zip.entry(CODE_INTEGRITY);
  return {
    kind: bundle ? 'bundle' : 'package',
    manifestName,
    manifest: new TextDecoder('utf-8', { fatal: true }).decode(await zip.read(required(zip, manifestName), MAX_METADATA)),
    blockMap: await zip.read(required(zip, BLOCK_MAP), MAX_METADATA),
    contentTypes: await zip.read(required(zip, CONTENT_TYPES), MAX_METADATA),
    signature: await zip.read(signature, MAX_METADATA),
    ...(codeIntegrity ? { codeIntegrity: await zip.read(codeIntegrity, MAX_METADATA) } : {}),
    axpc: await hashFileRange(zip.path, 0, signature.localHeaderOffset),
    axcd: Buffer.from(centralDirectoryWithoutSignature(zip, signature)).toString('hex'),
  };
}

export async function readAppxParts(file: string): Promise<AppxParts> {
  const zip = await ZipFile.open(file);
  try { return await partsOf(zip); }
  finally { await zip.close(); }
}

/** The <Identity> of a package manifest, or of a bundle manifest's <Bundle>. */
function identityOf(manifest: string): Readonly<Record<string, string>> {
  const document = parseXml(manifest);
  return onlyChild(document.root, 'Identity').attributes;
}

/** Zip entry names in a package are the block map's names with "/" for "\" and percent-encoding. */
function decodedEntryName(name: string): string {
  try { return decodeURIComponent(name); } catch { return name; }
}

async function blockMapProblems(zip: ZipFile, blockMapXml: Uint8Array): Promise<{ problems: string[]; files: number; bytes: number }> {
  const problems: string[] = [];
  const root = parseXml(new TextDecoder('utf-8', { fatal: true }).decode(blockMapXml)).root;
  if (root.localName !== 'BlockMap') throw new XmlError(`expected <BlockMap>, found <${root.name}>`, root.offset);
  if (root.attributes.HashMethod !== SHA256_METHOD) problems.push(`HashMethod: expected ${SHA256_METHOD}, found ${root.attributes.HashMethod ?? 'none'}`);
  const entries = new Map(zip.entries.map(entry => [decodedEntryName(entry.name), entry]));
  const listed = new Set<string>();
  let bytes = 0;
  const files: XmlElement[] = children(root, 'File');
  for (const file of files) {
    const name = (file.attributes.Name ?? '').replaceAll('\\', '/');
    const entry = entries.get(name);
    if (!name || !entry) { problems.push(`the block map lists ${file.attributes.Name ?? '(no name)'}, which the package does not contain`); continue; }
    if (listed.has(name)) { problems.push(`the block map lists ${name} twice`); continue; }
    listed.add(name);
    const size = Number(file.attributes.Size);
    if (!Number.isSafeInteger(size) || size !== entry.uncompressedSize) { problems.push(`${name}: the block map states ${file.attributes.Size} bytes, the package holds ${entry.uncompressedSize}`); continue; }
    const lfhSize = Number(file.attributes.LfhSize);
    if (lfhSize !== entry.dataOffset - entry.localHeaderOffset) problems.push(`${name}: the block map states a ${file.attributes.LfhSize}-byte local header, the package has ${entry.dataOffset - entry.localHeaderOffset}`);
    const blocks = children(file, 'Block').map(block => block.attributes.Hash ?? '');
    const expectedBlocks = Math.ceil(size / BLOCK_SIZE);
    if (blocks.length !== expectedBlocks) { problems.push(`${name}: ${size} bytes make ${expectedBlocks} blocks, the block map lists ${blocks.length}`); continue; }
    let index = 0;
    let pending: Buffer[] = [];
    let pendingSize = 0;
    const finishBlock = (block: Buffer) => {
      const actual = createHash('sha256').update(block).digest('base64');
      if (actual !== blocks[index]) problems.push(`${name}: block ${index} hashes to ${actual}, the block map states ${blocks[index]}`);
      index++;
    };
    try {
      for await (const chunk of zip.stream(entry)) {
        pending.push(Buffer.from(chunk));
        pendingSize += chunk.length;
        while (pendingSize >= BLOCK_SIZE) {
          const joined = Buffer.concat(pending, pendingSize);
          finishBlock(joined.subarray(0, BLOCK_SIZE));
          pending = [joined.subarray(BLOCK_SIZE)];
          pendingSize -= BLOCK_SIZE;
        }
      }
      if (pendingSize > 0) finishBlock(Buffer.concat(pending, pendingSize));
    } catch (error) {
      if (error instanceof ZipError) { problems.push(error.message); continue; }
      throw error;
    }
    bytes += size;
  }
  for (const entry of zip.entries) {
    const name = decodedEntryName(entry.name);
    if (!UNLISTED.has(name) && !listed.has(name)) problems.push(`the package contains ${name}, which the block map does not list`);
  }
  return { problems, files: files.length, bytes };
}

/**
 * Checks the manifest identity against the pinned Store identity (and the expected version and
 * architecture when given) and every file of the package against the block map. Signature checks
 * are in verifyAppxSignature.
 */
export async function verifyAppxPackage(file: string, trust: TrustAnchors, expected: { version?: string; arch?: string }): Promise<Check[]> {
  const verifier = APPX_VERIFIER;
  const anchor = trust.windowsStore;
  let zip: ZipFile;
  try { zip = await ZipFile.open(file); }
  catch (error) {
    if (error instanceof ZipError) return [fail('appx.manifest-identity', verifier, `not a readable package: ${error.message}`), fail('appx.block-map', verifier, 'not checked: the package could not be read')];
    throw error;
  }
  const checks: Check[] = [];
  try {
    let parts: AppxParts;
    try { parts = await partsOf(zip); }
    catch (error) {
      if (error instanceof ZipError) return [fail('appx.manifest-identity', verifier, error.message), fail('appx.block-map', verifier, 'not checked: the package could not be read')];
      throw error;
    }
    try {
      const identity = identityOf(parts.manifest);
      const problems: string[] = [];
      if (identity.Name !== anchor.packageIdentityName) problems.push(`Name: expected ${anchor.packageIdentityName}, found ${identity.Name}`);
      if (identity.Publisher !== anchor.publisher) problems.push(`Publisher: expected ${anchor.publisher}, found ${identity.Publisher}`);
      if (expected.version && identity.Version !== expected.version) problems.push(`Version: expected ${expected.version}, found ${identity.Version}`);
      if (expected.arch && parts.kind === 'package' && identity.ProcessorArchitecture !== expected.arch) problems.push(`ProcessorArchitecture: expected ${expected.arch}, found ${identity.ProcessorArchitecture}`);
      checks.push(problems.length === 0
        ? pass('appx.manifest-identity', verifier, `${parts.kind} ${identity.Name} ${identity.Version} ${identity.ProcessorArchitecture ?? ''}`.trim(), { identity: { ...identity }, manifest: parts.manifestName })
        : fail('appx.manifest-identity', verifier, problems.join('; '), { identity: { ...identity } }));
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
      checks.push(fail('appx.manifest-identity', verifier, `${parts.manifestName} could not be read: ${error.message}`));
    }
    try {
      const result = await blockMapProblems(zip, parts.blockMap);
      checks.push(result.problems.length === 0
        ? pass('appx.block-map', verifier, `${result.files} files (${result.bytes} bytes) match every 64 KiB block hash of the block map`, { files: result.files, bytes: result.bytes })
        : fail('appx.block-map', verifier, `${result.problems.length} problem(s): ${result.problems.slice(0, 5).join('; ')}`, { problems: result.problems.slice(0, 50) }));
    } catch (error) {
      if (!(error instanceof XmlError)) throw error;
      checks.push(fail('appx.block-map', verifier, `${BLOCK_MAP} could not be read: ${error.message}`));
    }
  } finally {
    await zip.close();
  }
  return checks;
}
