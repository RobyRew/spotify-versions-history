import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TrustAnchors } from '../../lib/trust.ts';
import { verifyAptIndex, verifyDeb, verifyInRelease } from '../../sensors/verify/apt.ts';
import { parseGpgvStatus } from '../../sensors/verify/gpgv.ts';
import { fixture, here, trust as loadTrust } from '../sensors/helpers.ts';

/** The recorded InRelease files were signed 2026-11-09; the pinned key expires 2027-02-14. */
const NOW = new Date('2026-11-20T12:00:00.000Z');

/** One ustar header plus the data, padded to 512-byte blocks. */
function tarEntry(name: string, data: Uint8Array): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\0', 257); header.write('00', 263);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return Buffer.concat([header, Buffer.from(data), Buffer.alloc((512 - (data.length % 512)) % 512)]);
}

function arMember(name: string, data: Uint8Array): Buffer {
  const header = Buffer.from(`${name.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'100644'.padEnd(8)}${String(data.length).padEnd(10)}\`\n`, 'latin1');
  return Buffer.concat([header, Buffer.from(data), data.length % 2 ? Buffer.from('\n') : Buffer.alloc(0)]);
}

function syntheticDeb(control: string): Uint8Array {
  const controlTar = Buffer.concat([tarEntry('./control', Buffer.from(control)), Buffer.alloc(1024)]);
  return new Uint8Array(Buffer.concat([
    Buffer.from('!<arch>\n', 'latin1'),
    arMember('debian-binary', Buffer.from('2.0\n')),
    arMember('control.tar.gz', gzipSync(controlTar)),
    arMember('data.tar.gz', gzipSync(Buffer.alloc(1024))),
  ]));
}

describe('apt', () => {
  let anchors: TrustAnchors;
  let keys: { fingerprint: string; key: Uint8Array }[];
  let directory: string;
  beforeAll(async () => {
    anchors = await loadTrust();
    keys = await Promise.all(anchors.apt.keys.map(async key => ({ fingerprint: key.fingerprint, key: new Uint8Array(await readFile(here(`../../ledger/trust/${key.file}`))) })));
    directory = await mkdtemp(join(tmpdir(), 'apt-'));
  });
  afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

  it.each(['stable', 'testing'])('verifies the %s InRelease signature by the pinned key', async suite => {
    const [check] = verifyInRelease(new Uint8Array(await fixture(`apt/${suite}-InRelease`)), keys, NOW);
    expect(check).toMatchObject({ id: 'apt.inrelease-signature', status: 'pass', data: { signer: anchors.apt.keys[0]!.fingerprint } });
  });

  it('fails the signature when one character of the signed text changes', async () => {
    const text = (await fixture('apt/stable-InRelease')).toString('utf8').replace('Origin: Spotify', 'Origin: Spotifx');
    expect(verifyInRelease(new Uint8Array(Buffer.from(text)), keys, NOW)[0]?.status).toBe('fail');
  });

  it('fails when the key file is not the pinned fingerprint, and when the signature block is damaged', async () => {
    const wrongPin = [{ ...keys[0]!, fingerprint: '0'.repeat(40) }];
    expect(verifyInRelease(new Uint8Array(await fixture('apt/stable-InRelease')), wrongPin, NOW)[0]?.detail).toMatch(/pinned as 0{40}/);
    const damaged = (await fixture('apt/stable-InRelease')).toString('utf8').replace(/(-----BEGIN PGP SIGNATURE-----\n\n)(.)/, (_, head: string, first: string) => `${head}${first === 'A' ? 'B' : 'A'}`);
    expect(verifyInRelease(new Uint8Array(Buffer.from(damaged)), keys, NOW)[0]?.status).toBe('fail');
    expect(verifyInRelease(new Uint8Array(Buffer.from('not clearsigned')), keys, NOW)[0]?.status).toBe('fail');
  });

  it('fails a signature checked after the pinned key expired', async () => {
    expect(verifyInRelease(new Uint8Array(await fixture('apt/stable-InRelease')), keys, new Date('2027-03-01T00:00:00Z'))[0]?.status).toBe('fail');
  });

  it('checks Packages against the hash the signed InRelease lists', async () => {
    const inRelease = new Uint8Array(await fixture('apt/stable-InRelease'));
    const packages = new Uint8Array(await fixture('apt/stable-amd64-Packages'));
    expect(verifyAptIndex('stable', inRelease, packages)[0]?.status).toBe('pass');
    const changed = new Uint8Array(packages);
    changed[10]! ^= 0x01;
    expect(verifyAptIndex('stable', inRelease, changed)[0]?.status).toBe('fail');
  });

  it('checks a .deb\'s digest and control fields', async () => {
    const deb = syntheticDeb('Package: spotify-client\nVersion: 1:1.3.4.258.gc60b10b0946a\nArchitecture: amd64\n');
    const path = join(directory, 'spotify-client.deb');
    await writeFile(path, deb);
    const expected = { sha256: createHash('sha256').update(deb).digest('hex'), size: deb.length, package: 'spotify-client', version: '1:1.3.4.258.gc60b10b0946a', architecture: 'amd64' };
    expect((await verifyDeb(path, expected)).map(check => check.status)).toEqual(['pass', 'pass']);
    const other = await verifyDeb(path, { ...expected, sha256: '0'.repeat(64), version: '1:1.3.5.0.gabcdef' });
    expect(other.map(check => [check.id, check.status])).toEqual([['apt.deb-digest', 'fail'], ['apt.deb-control', 'fail']]);
    const broken = join(directory, 'broken.deb');
    await writeFile(broken, new Uint8Array(Buffer.from('!<arch>\nnot really')));
    expect((await verifyDeb(broken, expected))[1]).toMatchObject({ id: 'apt.deb-control', status: 'fail' });
  });

  it('reads gpgv\'s status lines', () => {
    const good = parseGpgvStatus('[GNUPG:] NEWSIG\n[GNUPG:] GOODSIG 5384CE82BA52C83A Spotify Public Repository Signing Key <tux@spotify.com>\n[GNUPG:] VALIDSIG E1096BCBFF6D418796DE78515384CE82BA52C83A 2026-11-09 1762678802 0 4 0 1 8 01 E1096BCBFF6D418796DE78515384CE82BA52C83A\n');
    expect(good).toEqual({ goodsig: true, validsig: ['E1096BCBFF6D418796DE78515384CE82BA52C83A'], badsig: false });
    expect(parseGpgvStatus('[GNUPG:] BADSIG 5384CE82BA52C83A Spotify\n').badsig).toBe(true);
  });
});
