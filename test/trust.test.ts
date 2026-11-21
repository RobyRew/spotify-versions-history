import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCertificates, loadTrust, TrustAnchors } from '../lib/trust.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/** v4 OpenPGP fingerprint of the first public-key packet: SHA-1 over 0x99, a two-byte length and the packet body. */
function primaryKeyFingerprint(key: Uint8Array): string {
  const tagByte = key[0]!;
  let length: number;
  let start: number;
  if (tagByte & 0x40) {
    if ((tagByte & 0x3f) !== 6) throw new Error('first packet is not a public key');
    const first = key[1]!;
    if (first < 192) { length = first; start = 2; }
    else if (first < 224) { length = ((first - 192) << 8) + key[2]! + 192; start = 3; }
    else { length = Buffer.from(key.subarray(2, 6)).readUInt32BE(); start = 6; }
  } else {
    if (((tagByte >> 2) & 0x0f) !== 6) throw new Error('first packet is not a public key');
    const lengthBytes = [1, 2, 4][tagByte & 3]!;
    length = Buffer.from(key.subarray(1, 1 + lengthBytes)).readUIntBE(0, lengthBytes);
    start = 1 + lengthBytes;
  }
  const body = key.subarray(start, start + length);
  return createHash('sha1').update(Buffer.from([0x99, length >> 8, length & 0xff])).update(body).digest('hex').toUpperCase();
}

describe('trust anchors', async () => {
  const anchors = await loadTrust(here('../ledger/trust/anchors.json'));

  it('parse against their schema', () => {
    expect(anchors.macos.teamId).toBe('2FNC3A47ZF');
    expect(anchors.windowsStore.packageFamilyName.startsWith(`${anchors.windowsStore.packageIdentityName}_`)).toBe(true);
  });

  it('pin apt key files whose fingerprint is the one written next to them', async () => {
    for (const key of anchors.apt.keys) {
      const file = new Uint8Array(await readFile(here(`../ledger/trust/${key.file}`)));
      expect(primaryKeyFingerprint(file)).toBe(key.fingerprint);
    }
  });

  it('pin root certificate files whose SHA-256 is the one written next to them', async () => {
    const names = Object.keys(anchors.certificates);
    const certificates = await loadCertificates(anchors, names, here('../ledger/trust'));
    expect(certificates).toHaveLength(names.length);
    for (const certificate of certificates) expect(certificate.ca).toBe(true);
  });

  it('refuse a certificate file whose SHA-256 differs from the pin', async () => {
    const tampered = structuredClone(anchors);
    tampered.certificates['digicert-trusted-root-g4']!.sha256 = '0'.repeat(64);
    await expect(loadCertificates(tampered, ['digicert-trusted-root-g4'], here('../ledger/trust'))).rejects.toThrow(/not the pinned/);
  });

  it('reject a platform that names a root certificate the anchors do not pin', async () => {
    const raw = JSON.parse(await readFile(here('../ledger/trust/anchors.json'), 'utf8'));
    raw.windowsStore.signingRoots = ['nonexistent-root'];
    expect(TrustAnchors.safeParse(raw).success).toBe(false);
  });
});
