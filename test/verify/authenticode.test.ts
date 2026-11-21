import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCertificates, type TrustAnchors } from '../../lib/trust.ts';
import { parseCertificateTable, verifyAuthenticode, type PinnedRoots } from '../../sensors/verify/authenticode.ts';
import type { Check } from '../../sensors/verify/types.ts';
import { here, syntheticPe, trust as loadTrust } from '../sensors/helpers.ts';

const TABLE = here('../../testdata/verify/authenticode/SpotifySetup-1.3.10.2586.certificate-table');
const SIGNED_IMAGE_DIGEST = '94ae55a17db6cedb96869a22cca71a4a3b3a72546a77860c342ace2078ede751';
/** messageDigest attribute type, 1.2.840.113549.1.9.4, as DER. */
const MESSAGE_DIGEST_OID = Buffer.from('06092a864886f70d010904', 'hex');
/** Signed 2026-11-13; the signer certificate is valid well past it. */
const NOW = new Date('2026-11-20T12:00:00.000Z');

/**
 * A synthetic PE32+ image (test/sensors/helpers.ts) whose certificate table is `table`: the real
 * signature of another file, so everything but the image digest verifies.
 */
function peWithTable(table: Uint8Array): Uint8Array {
  const base = Buffer.from(syntheticPe(0x8664, '1.3.10.2586.g81a118a22460'));
  const security = 0x80 + 24 + 112 + 32;
  const placeholderOffset = base.readUInt32LE(security);
  const body = base.subarray(0, placeholderOffset);
  const offset = Math.ceil(body.length / 8) * 8;
  const image = Buffer.concat([body, Buffer.alloc(offset - body.length), table]);
  image.writeUInt32LE(offset, security);
  image.writeUInt32LE(table.length, security + 4);
  return new Uint8Array(image);
}

const byId = (checks: Check[]) => Object.fromEntries(checks.map(check => [check.id, check]));

describe('Authenticode', () => {
  let directory: string;
  let anchors: TrustAnchors;
  let pinned: PinnedRoots;
  let table: Uint8Array;
  const write = async (name: string, bytes: Uint8Array) => { const path = join(directory, name); await writeFile(path, bytes); return path; };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'authenticode-'));
    anchors = await loadTrust();
    const trustDirectory = here('../../ledger/trust');
    pinned = {
      roots: await loadCertificates(anchors, anchors.windows.authenticode.roots, trustDirectory),
      timestampRoots: await loadCertificates(anchors, anchors.windows.authenticode.timestampRoots, trustDirectory),
    };
    table = new Uint8Array(await readFile(TABLE));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it('reads one PKCS #7 WIN_CERTIFICATE from the real table', () => {
    const entries = parseCertificateTable(table);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ revision: 0x0200, type: 0x0002 });
  });

  it('verifies the real signature, timestamp, chain and signer, and fails the image digest of different bytes', async () => {
    const checks = byId(await verifyAuthenticode(await write('signed-elsewhere.exe', peWithTable(table)), anchors, pinned, NOW));
    expect(checks['authenticode.structure']?.status).toBe('pass');
    expect(checks['authenticode.signature']?.status).toBe('pass');
    expect(checks['authenticode.timestamp']).toMatchObject({ status: 'pass', data: { kind: 'rfc3161', time: '2026-11-13T17:26:01.000Z' } });
    expect(checks['authenticode.chain']?.status).toBe('pass');
    expect((checks['authenticode.chain']?.data?.chain as string[]).at(-1)).toMatch(/^CN=DigiCert Trusted Root G4/);
    expect(checks['authenticode.signer']?.status).toBe('pass');
    expect(checks['authenticode.image-digest']?.status).toBe('fail');
    expect(checks['authenticode.image-digest']?.detail).toContain(SIGNED_IMAGE_DIGEST);
  });

  it('fails the signature when one byte of the signed attributes changes', async () => {
    const tampered = new Uint8Array(table);
    const at = Buffer.from(tampered).indexOf(MESSAGE_DIGEST_OID);
    expect(at).toBeGreaterThan(0);
    // SET { OCTET STRING (32 bytes) } follows the OID: flip the digest's last byte.
    tampered[at + MESSAGE_DIGEST_OID.length + 2 + 2 + 31]! ^= 0x01;
    const checks = byId(await verifyAuthenticode(await write('tampered.exe', peWithTable(tampered)), anchors, pinned, NOW));
    expect(checks['authenticode.signature']?.status).toBe('fail');
  });

  it('fails the chain against a root that did not issue it', async () => {
    const wrong = await loadCertificates(anchors, ['microsoft-root-2011'], here('../../ledger/trust'));
    const checks = byId(await verifyAuthenticode(await write('wrong-root.exe', peWithTable(table)), anchors, { ...pinned, roots: wrong }, NOW));
    expect(checks['authenticode.chain']?.status).toBe('fail');
    expect(checks['authenticode.timestamp']?.status).toBe('pass');
  });

  it('fails the timestamp against a timestamp root that did not issue it', async () => {
    const wrong = await loadCertificates(anchors, ['microsoft-root-2010'], here('../../ledger/trust'));
    const checks = byId(await verifyAuthenticode(await write('wrong-tsa-root.exe', peWithTable(table)), anchors, { ...pinned, timestampRoots: wrong }, NOW));
    expect(checks['authenticode.timestamp']?.status).toBe('fail');
  });

  it('fails the signer when the pinned subject differs', async () => {
    const other = structuredClone(anchors);
    other.windows.authenticode.subject.serialNumber = '000000-0000';
    const checks = byId(await verifyAuthenticode(await write('other-subject.exe', peWithTable(table)), other, pinned, NOW));
    expect(checks['authenticode.signer']).toMatchObject({ status: 'fail' });
    expect(checks['authenticode.signer']?.detail).toMatch(/serialNumber: expected "000000-0000", found "556703-7485"/);
  });

  it('fails the signer when the pinned issuer differs', async () => {
    const other = structuredClone(anchors);
    other.windows.authenticode.issuer = 'CN=Another CA, O=DigiCert, Inc., C=US';
    const checks = byId(await verifyAuthenticode(await write('other-issuer.exe', peWithTable(table)), other, pinned, NOW));
    expect(checks['authenticode.signer']?.status).toBe('fail');
  });

  it('reports an unsigned file and a damaged table as structure failures without throwing', async () => {
    const unsigned = Buffer.from(syntheticPe(0x8664, '1.3.10.2586.g81a118a22460'));
    unsigned.writeUInt32LE(0, 0x80 + 24 + 112 + 32);
    unsigned.writeUInt32LE(0, 0x80 + 24 + 112 + 36);
    expect(await verifyAuthenticode(await write('unsigned.exe', new Uint8Array(unsigned)), anchors, pinned, NOW))
      .toEqual([expect.objectContaining({ id: 'authenticode.structure', status: 'fail' })]);

    const truncated = table.subarray(0, 4000);
    const damaged = await verifyAuthenticode(await write('truncated.exe', peWithTable(truncated)), anchors, pinned, NOW);
    expect(damaged).toEqual([expect.objectContaining({ id: 'authenticode.structure', status: 'fail' })]);

    const garbage = new Uint8Array(table);
    garbage.fill(0x41, 8, 64);
    const unreadable = await verifyAuthenticode(await write('garbage.exe', peWithTable(garbage)), anchors, pinned, NOW);
    expect(unreadable).toEqual([expect.objectContaining({ id: 'authenticode.structure', status: 'fail' })]);

    expect(await verifyAuthenticode(await write('not-a-pe.exe', new Uint8Array(Buffer.from('plain text, not an executable'))), anchors, pinned, NOW))
      .toEqual([expect.objectContaining({ id: 'authenticode.structure', status: 'fail' })]);
  });
});
