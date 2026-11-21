/**
 * Spotify's apt repository, checked the way apt checks it, in-process:
 *  1. InRelease: an OpenPGP canonical-text signature (sensors/lib/openpgp.ts) by a pinned key or its
 *     bound signing subkey (ledger/trust/apt), valid when made and now;
 *  2. Packages: its SHA-256 and size are the ones the signed InRelease lists;
 *  3. the .deb: its SHA-256 and size are the ones Packages lists, and its control file names the
 *     package, version and architecture.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parseClearsigned, parseControl, parseRelease } from '../lib/deb.ts';
import { canonicalText, dearmor, OpenPgpError, parseSignature, readCertificates, readPackets, verifyDocumentSignature } from '../lib/openpgp.ts';
import { TarError, tarFiles } from '../lib/tar.ts';
import { fail, pass, type Check } from './types.ts';

export const APT_VERIFIER = 'svh-apt/1';
const PACKAGES_PATH = 'non-free/binary-amd64/Packages';
const MAX_CONTROL_ARCHIVE = 16 * 1024 * 1024;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** InRelease's signature by one of the pinned keys; `keys` are the pinned key files with their fingerprints. */
export function verifyInRelease(inRelease: Uint8Array, keys: readonly { fingerprint: string; key: Uint8Array }[], now: Date): Check[] {
  const verifier = APT_VERIFIER;
  try {
    const certificates = keys.flatMap(({ fingerprint, key }) => {
      const found = readCertificates(key);
      const pinned = found.filter(certificate => certificate.primary.fingerprint === fingerprint);
      if (pinned.length !== 1) throw new OpenPgpError('invalid', `the key file pinned as ${fingerprint} holds ${found.map(certificate => certificate.primary.fingerprint).join(', ') || 'no key'}`);
      return pinned;
    });
    const message = parseClearsigned(Buffer.from(inRelease).toString('utf8'));
    const armor = dearmor(message.signature);
    if (armor.label !== 'SIGNATURE') throw new OpenPgpError('malformed', `expected a PGP SIGNATURE block, found ${armor.label}`);
    const signatures = readPackets(armor.data).filter(packet => packet.tag === 2).map(packet => parseSignature(packet.body));
    if (signatures.length === 0) throw new OpenPgpError('malformed', 'the signature block holds no signature packet');
    const document = canonicalText(message.body);
    const verdicts = signatures.map(signature => verifyDocumentSignature(certificates, signature, document, now, [0x01]));
    const good = verdicts.find(verdict => verdict.status === 'good');
    if (good && good.status === 'good') {
      return [pass('apt.inrelease-signature', verifier, good.detail, {
        signer: good.signer.fingerprint, primary: good.primary.fingerprint, created: good.created.toISOString(), keyExpires: good.keyExpires?.toISOString() ?? null,
      })];
    }
    return [fail('apt.inrelease-signature', verifier, verdicts.map(verdict => verdict.detail).join('; '))];
  } catch (error) {
    if (error instanceof OpenPgpError || (error instanceof Error && /clearsigned/i.test(error.message))) return [fail('apt.inrelease-signature', verifier, error.message)];
    throw error;
  }
}

/** Packages must be the file the signed InRelease lists, by SHA-256 and size. */
export function verifyAptIndex(suite: string, inRelease: Uint8Array, packages: Uint8Array): Check[] {
  const verifier = APT_VERIFIER;
  let listed: { hash: string; size: number } | undefined;
  try { listed = parseRelease(parseClearsigned(Buffer.from(inRelease).toString('utf8')).body).sha256.get(PACKAGES_PATH); }
  catch (error) { return [fail('apt.packages-digest', verifier, `${suite} InRelease could not be read: ${(error as Error).message}`)]; }
  if (!listed) return [fail('apt.packages-digest', verifier, `${suite} InRelease lists no SHA-256 for ${PACKAGES_PATH}`)];
  const actual = sha256(packages);
  return listed.hash === actual && listed.size === packages.length
    ? [pass('apt.packages-digest', verifier, `${suite} ${PACKAGES_PATH}: ${packages.length} bytes, sha256 ${actual} as InRelease lists`)]
    : [fail('apt.packages-digest', verifier, `${suite} ${PACKAGES_PATH}: InRelease lists ${listed.size} bytes ${listed.hash}, the file is ${packages.length} bytes ${actual}`)];
}

/** The control file of a .deb: ar member control.tar.gz, then ./control in it. */
async function debControl(file: string): Promise<Record<string, string>> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const read = async (position: number, length: number) => {
      if (position + length > size) throw new TarError(`the .deb ends before byte ${position + length}`);
      const bytes = new Uint8Array(length);
      await handle.read(bytes, 0, length, position);
      return bytes;
    };
    if (Buffer.from(await read(0, 8)).toString('latin1') !== '!<arch>\n') throw new TarError('not an ar archive');
    let at = 8;
    for (let member = 0; member < 3 && at + 60 <= size; member++) {
      const header = Buffer.from(await read(at, 60));
      if (header.subarray(58, 60).toString('latin1') !== '`\n') throw new TarError(`ar member header at ${at} is corrupt`);
      const name = header.subarray(0, 16).toString('latin1').trim().replace(/\/$/, '');
      const length = Number(header.subarray(48, 58).toString('latin1').trim());
      if (!Number.isSafeInteger(length) || length < 0) throw new TarError(`ar member ${name} has the size "${header.subarray(48, 58).toString('latin1').trim()}"`);
      if (name.startsWith('control.tar')) {
        if (name !== 'control.tar.gz') throw new TarError(`${name}: only gzip control archives are read`);
        if (length > MAX_CONTROL_ARCHIVE) throw new TarError(`${name} is ${length} bytes`);
        const archive = gunzipSync(await read(at + 60, length), { maxOutputLength: 64 * 1024 * 1024 });
        const files = tarFiles(new Uint8Array(archive));
        const control = files.get('./control') ?? files.get('control');
        if (!control) throw new TarError(`${name} holds no control file`);
        const [paragraph] = parseControl(Buffer.from(control).toString('utf8'));
        if (!paragraph) throw new TarError('the control file is empty');
        return paragraph;
      }
      at += 60 + length + (length % 2);
    }
    throw new TarError('no control.tar member among the first three ar members');
  } finally {
    await handle.close();
  }
}

export async function verifyDeb(file: string, expected: { sha256: string; size: number; package: string; version: string; architecture: string }): Promise<Check[]> {
  const verifier = APT_VERIFIER;
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; }
  const actual = hash.digest('hex');
  const checks: Check[] = [actual === expected.sha256 && size === expected.size
    ? pass('apt.deb-digest', verifier, `${size} bytes, sha256 ${actual} as Packages lists`)
    : fail('apt.deb-digest', verifier, `Packages lists ${expected.size} bytes ${expected.sha256}, the file is ${size} bytes ${actual}`)];
  try {
    const control = await debControl(file);
    const problems = (['Package', 'Version', 'Architecture'] as const)
      .map(fieldName => [fieldName, control[fieldName], { Package: expected.package, Version: expected.version, Architecture: expected.architecture }[fieldName]] as const)
      .filter(([, found, wanted]) => found !== wanted)
      .map(([fieldName, found, wanted]) => `${fieldName}: expected ${wanted}, found ${found ?? 'none'}`);
    checks.push(problems.length === 0
      ? pass('apt.deb-control', verifier, `${control.Package} ${control.Version} ${control.Architecture}`)
      : fail('apt.deb-control', verifier, problems.join('; ')));
  } catch (error) {
    if (!(error instanceof TarError) && !(error instanceof Error && /incorrect header|unexpected end|invalid/.test(error.message))) throw error;
    checks.push(fail('apt.deb-control', verifier, `the control file could not be read: ${(error as Error).message}`));
  }
  return checks;
}
