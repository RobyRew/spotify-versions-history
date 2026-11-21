import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCertificates, type TrustAnchors } from '../../lib/trust.ts';
import { ZipFile } from '../../sensors/lib/zipfile.ts';
import { readAppxParts, verifyAppxPackage } from '../../sensors/verify/appx.ts';
import { appxDigestRecords, verifyAppxSignature } from '../../sensors/verify/appx-signature.ts';
import type { PinnedRoots } from '../../sensors/verify/authenticode.ts';
import type { Check } from '../../sensors/verify/types.ts';
import { here, trust as loadTrust } from '../sensors/helpers.ts';

const P7X = here('../../testdata/verify/appx/signature-SpotifyMusic_1.310.2586.0_x64.p7x');
const NOW = new Date('2026-11-20T12:00:00.000Z');
const PUBLISHER = 'CN=453637B3-4E12-4CDF-B0D3-2A3C863BF6EF';
const byId = (checks: Check[]) => Object.fromEntries(checks.map(check => [check.id, check]));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest();

/** A stored-only zip with the entries in order; zip64 adds ZIP64 end records and saturates the classic one. */
function zip(entries: { name: string; data: Uint8Array }[], zip64 = false): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(45, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, Buffer.from(data));
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end: Buffer[] = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0); record.writeBigUInt64LE(44n, 4); record.writeUInt16LE(45, 12); record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24); record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40); record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16);
    end.push(record, locator);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8); eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12); eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, ...end, eocd]));
}

/** A package with a manifest, two files (one spanning two 64 KiB blocks), its block map and a stand-in signature. */
function syntheticPackage(options: { zip64?: boolean; tamper?: boolean; unlisted?: boolean; publisher?: string; unsigned?: boolean } = {}): Uint8Array {
  const manifest = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"><Identity Name="SpotifyAB.SpotifyMusic" Version="1.310.2586.0" ProcessorArchitecture="x64" Publisher="${options.publisher ?? PUBLISHER}" /></Package>`);
  const big = new Uint8Array(70_000).map((_, index) => index % 251);
  const files = [
    { name: 'AppxManifest.xml', blockName: 'AppxManifest.xml', data: new Uint8Array(manifest) },
    { name: 'Spotify/Spotify.exe', blockName: 'Spotify\\Spotify.exe', data: big },
  ];
  const blockMap = `<?xml version="1.0" encoding="UTF-8"?><BlockMap xmlns="http://schemas.microsoft.com/appx/2010/blockmap" HashMethod="http://www.w3.org/2001/04/xmlenc#sha256">${files.map(file => {
    const blocks = [];
    for (let at = 0; at < file.data.length; at += 65536) blocks.push(`<Block Hash="${sha256(file.data.subarray(at, at + 65536)).toString('base64')}"/>`);
    return `<File Name="${file.blockName}" Size="${file.data.length}" LfhSize="${30 + Buffer.byteLength(file.name)}">${blocks.join('')}</File>`;
  }).join('')}</BlockMap>`;
  const stored = files.map(file => ({ name: file.name, data: file.data }));
  if (options.tamper) stored[1] = { name: stored[1]!.name, data: new Uint8Array(big).fill(7, 66000, 66001) };
  if (options.unlisted) stored.push({ name: 'extra.dll', data: new Uint8Array([1, 2, 3]) });
  return zip([
    ...stored,
    { name: 'AppxBlockMap.xml', data: new Uint8Array(Buffer.from(blockMap)) },
    { name: '[Content_Types].xml', data: new Uint8Array(Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')) },
    ...(options.unsigned ? [] : [{ name: 'AppxSignature.p7x', data: new Uint8Array(Buffer.from('PKCX stand-in')) }]),
  ], options.zip64);
}

describe('Store package parts and checks', () => {
  let directory: string;
  let anchors: TrustAnchors;
  const write = async (name: string, bytes: Uint8Array) => { const path = join(directory, name); await writeFile(path, bytes); return path; };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'appx-'));
    anchors = await loadTrust();
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each([false, true])('reads the parts and the zip digests of a package (zip64 %s)', async zip64 => {
    const bytes = syntheticPackage({ zip64 });
    const path = await write(`package-${zip64}.appx`, bytes);
    const parts = await readAppxParts(path);
    expect(parts.kind).toBe('package');
    expect(parts.manifest).toContain('SpotifyAB.SpotifyMusic');
    const archive = await ZipFile.open(path);
    const signature = archive.entry('AppxSignature.p7x')!;
    await archive.close();
    expect(parts.axpc).toBe(sha256(bytes.subarray(0, signature.localHeaderOffset)).toString('hex'));
    // AXCD covers the directory and end records as if the signature file were absent, which is what
    // the same package written without that file holds from the signature's offset on.
    const unsigned = syntheticPackage({ zip64, unsigned: true });
    expect(parts.axcd).toBe(sha256(unsigned.subarray(signature.localHeaderOffset)).toString('hex'));
  });

  it.each([false, true])('passes the identity and every block of an intact package (zip64 %s)', async zip64 => {
    const checks = byId(await verifyAppxPackage(await write(`intact-${zip64}.appx`, syntheticPackage({ zip64 })), anchors, { version: '1.310.2586.0', arch: 'x64' }));
    expect(checks['appx.manifest-identity']?.status).toBe('pass');
    expect(checks['appx.block-map']).toMatchObject({ status: 'pass', data: { files: 2, bytes: expect.any(Number) } });
  });

  it('fails the block map when one byte of a file changes and when a file is not listed', async () => {
    const tampered = byId(await verifyAppxPackage(await write('tampered.appx', syntheticPackage({ tamper: true })), anchors, {}));
    expect(tampered['appx.block-map']?.status).toBe('fail');
    expect(tampered['appx.block-map']?.detail).toMatch(/Spotify\/Spotify\.exe: block 1 hashes to/);
    const unlisted = byId(await verifyAppxPackage(await write('unlisted.appx', syntheticPackage({ unlisted: true })), anchors, {}));
    expect(unlisted['appx.block-map']?.detail).toMatch(/extra\.dll, which the block map does not list/);
  });

  it('fails the identity for another publisher, version or architecture', async () => {
    const other = byId(await verifyAppxPackage(await write('other.appx', syntheticPackage({ publisher: 'CN=Someone Else' })), anchors, { version: '1.0.0.0', arch: 'arm64' }));
    expect(other['appx.manifest-identity']?.detail).toMatch(/Publisher: expected CN=453637B3.*Version: expected 1\.0\.0\.0.*ProcessorArchitecture: expected arm64/);
  });

  it('reports a file that is not a zip as failed checks without throwing', async () => {
    const checks = await verifyAppxPackage(await write('not-a-zip.appx', new Uint8Array(Buffer.from('not a package'))), anchors, {});
    expect(checks.map(check => [check.id, check.status])).toEqual([['appx.manifest-identity', 'fail'], ['appx.block-map', 'fail']]);
  });
});

describe('Store package signature', () => {
  let anchors: TrustAnchors;
  let pinned: PinnedRoots;
  let p7x: Uint8Array;
  const parts = { blockMap: new Uint8Array([1]), contentTypes: new Uint8Array([2]), codeIntegrity: new Uint8Array([3]), axpc: '0'.repeat(64), axcd: '0'.repeat(64) };
  beforeAll(async () => {
    anchors = await loadTrust();
    const trustDirectory = here('../../ledger/trust');
    pinned = {
      roots: await loadCertificates(anchors, anchors.windowsStore.signingRoots, trustDirectory),
      timestampRoots: await loadCertificates(anchors, anchors.windowsStore.timestampRoots, trustDirectory),
    };
    p7x = new Uint8Array(await readFile(P7X));
  });

  it('verifies the real signer, chain and timestamp, and fails digests of other content', () => {
    const checks = byId(verifyAppxSignature(p7x, parts, anchors, pinned, NOW));
    expect(checks['appx.signature-structure']?.status).toBe('pass');
    expect(checks['appx.signature']?.status).toBe('pass');
    expect(checks['appx.timestamp']).toMatchObject({ status: 'pass', data: { kind: 'rfc3161' } });
    expect(checks['appx.chain']?.status).toBe('pass');
    expect((checks['appx.chain']?.data?.chain as string[]).at(-1)).toMatch(/^CN=Microsoft Root Certificate Authority 2011/);
    expect(checks['appx.signer']?.status).toBe('pass');
    expect(checks['appx.content-digests']?.status).toBe('fail');
    expect(checks['appx.content-digests']?.detail).toMatch(/AXPC: signed 856b2bbc06c48c83/);
  });

  it('reads the five signed digest records', () => {
    const at = Buffer.from(p7x).indexOf('APPX');
    const records = appxDigestRecords(p7x.subarray(at, at + 4 + 5 * 36));
    expect([...records.keys()]).toEqual(['AXPC', 'AXCD', 'AXCT', 'AXBM', 'AXCI']);
    expect(records.get('AXBM')).toMatch(/^7272311054c7cb21/);
  });

  it('fails the signer for another pinned publisher and the chain for another root', async () => {
    const other = structuredClone(anchors);
    other.windowsStore.publisher = 'CN=00000000-0000-0000-0000-000000000000';
    expect(byId(verifyAppxSignature(p7x, parts, other, pinned, NOW))['appx.signer']?.status).toBe('fail');
    const digicert = await loadCertificates(anchors, ['digicert-trusted-root-g4'], here('../../ledger/trust'));
    expect(byId(verifyAppxSignature(p7x, parts, anchors, { ...pinned, roots: digicert }, NOW))['appx.chain']?.status).toBe('fail');
  });

  it('fails the signature when one byte of the signed digest changes, and the structure for a damaged blob', () => {
    const tampered = new Uint8Array(p7x);
    const at = Buffer.from(tampered).indexOf('AXBM');
    tampered[at + 4]! ^= 0x01;
    expect(byId(verifyAppxSignature(tampered, parts, anchors, pinned, NOW))['appx.signature']?.status).toBe('fail');
    expect(verifyAppxSignature(p7x.subarray(0, 2000), parts, anchors, pinned, NOW)).toEqual([expect.objectContaining({ id: 'appx.signature-structure', status: 'fail' })]);
    expect(verifyAppxSignature(new Uint8Array(Buffer.from('MZ not a signature')), parts, anchors, pinned, NOW)).toEqual([expect.objectContaining({ id: 'appx.signature-structure', status: 'fail' })]);
  });
});
