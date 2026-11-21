/**
 * Canonical's snap assertions, checked in-process up to the root key snapd trusts.
 *
 * An assertion is its headers, a blank line, an optional body of `body-length` bytes followed by a
 * blank line, and its signature. The signature covers every byte before the blank line that precedes
 * it. Bodies and signatures are base64 of a format byte (0x01) followed by an OpenPGP packet: an
 * account-key's body is its public key packet, and its id (public-key-sha3-384) is the unpadded
 * base64url SHA3-384 of that decoded blob; a signature is a binary-document signature packet.
 *
 * Chain for a snap file: the snap-revision assertion is signed by the key its sign-key-sha3-384 names
 * (Canonical's store key), whose account-key assertion is signed by the root key, whose own assertion
 * is self-signed and must carry the id pinned in ledger/trust/anchors.json (snapd's
 * asserts/sysdb/trusted.go). The revision then names the file's SHA3-384, size, snap-id and publisher.
 */
import { createHash } from 'node:crypto';
import type { TrustAnchors } from '../../lib/trust.ts';
import { OpenPgpError, parsePublicKey, parseSignature, readPackets, verifySignature, type PublicKey } from '../lib/openpgp.ts';
import { fail, pass, type Check } from './types.ts';

export const SNAP_VERIFIER = 'svh-snap/1';

export class AssertionError extends Error {
  override name = 'AssertionError';
}

export interface Assertion {
  type: string;
  /** Single-line headers; a header with an indented multi-line value maps to "". */
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
  /** The bytes the signature covers. */
  content: Uint8Array;
  /** The decoded signature: format byte 0x01 and an OpenPGP signature packet. */
  signature: Uint8Array;
}

const BLANK = Buffer.from('\n\n');

function decodeBlob(text: string, what: string): Uint8Array {
  const compact = text.replace(/\n/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) throw new AssertionError(`${what} is not base64`);
  const bytes = Buffer.from(compact, 'base64');
  if (bytes.toString('base64') !== compact) throw new AssertionError(`${what} is not canonical base64`);
  if (bytes[0] !== 0x01) throw new AssertionError(`${what}: expected format byte 0x01, found 0x${(bytes[0] ?? 0).toString(16)}`);
  return new Uint8Array(bytes);
}

/** The assertions of a stream, in order. */
export function parseAssertions(input: string | Uint8Array): Assertion[] {
  const data = Buffer.from(typeof input === 'string' ? Buffer.from(input, 'utf8') : input);
  const assertions: Assertion[] = [];
  let at = 0;
  while (at < data.length) {
    while (at < data.length && data[at] === 0x0a) at++;
    if (at >= data.length) break;
    const headersEnd = data.indexOf(BLANK, at);
    if (headersEnd < 0) throw new AssertionError(`an assertion at byte ${at} has no blank line after its headers`);
    const headers: Record<string, string> = {};
    for (const line of data.subarray(at, headersEnd).toString('utf8').split('\n')) {
      if (line.startsWith(' ')) continue;
      const colon = line.indexOf(':');
      if (colon <= 0) throw new AssertionError(`header line "${line}" is not "name: value"`);
      const name = line.slice(0, colon);
      if (name in headers) throw new AssertionError(`header ${name} appears twice`);
      headers[name] = line.slice(colon + 1).trim();
    }
    const type = headers.type;
    if (!type) throw new AssertionError(`an assertion at byte ${at} has no type header`);
    const bodyLength = headers['body-length'] === undefined ? 0 : Number(headers['body-length']);
    if (!Number.isSafeInteger(bodyLength) || bodyLength < 0) throw new AssertionError(`${type}: body-length "${headers['body-length']}" is not a length`);
    let contentEnd = headersEnd;
    let body: Uint8Array = new Uint8Array(0);
    if (bodyLength > 0) {
      const bodyStart = headersEnd + 2;
      contentEnd = bodyStart + bodyLength;
      if (contentEnd + 2 > data.length || !data.subarray(contentEnd, contentEnd + 2).equals(BLANK)) throw new AssertionError(`${type}: the body of ${bodyLength} bytes is not followed by a blank line`);
      body = new Uint8Array(data.subarray(bodyStart, contentEnd));
    }
    const signatureStart = contentEnd + 2;
    const next = data.indexOf(BLANK, signatureStart);
    const signatureEnd = next < 0 ? data.length : next;
    const signatureText = data.subarray(signatureStart, signatureEnd).toString('utf8').trim();
    if (!signatureText) throw new AssertionError(`${type}: no signature`);
    assertions.push({ type, headers, body, content: new Uint8Array(data.subarray(at, contentEnd)), signature: decodeBlob(signatureText, `${type} signature`) });
    at = signatureEnd;
  }
  return assertions;
}

/** The id snapd gives a public key: unpadded base64url of the SHA3-384 of its encoded blob. */
export function publicKeyId(blob: Uint8Array): string {
  return createHash('sha3-384').update(blob).digest('base64url');
}

interface AccountKey {
  assertion: Assertion;
  id: string;
  key: PublicKey;
}

function accountKey(assertion: Assertion): AccountKey {
  if (assertion.type !== 'account-key') throw new AssertionError(`expected an account-key assertion, found ${assertion.type}`);
  const blob = decodeBlob(Buffer.from(assertion.body).toString('utf8').trim(), 'account-key body');
  const id = publicKeyId(blob);
  if (id !== assertion.headers['public-key-sha3-384']) throw new AssertionError(`the account-key's key hashes to ${id}, not its public-key-sha3-384 ${assertion.headers['public-key-sha3-384']}`);
  const packets = readPackets(blob.subarray(1));
  if (packets.length !== 1 || packets[0]!.tag !== 6) throw new AssertionError('the account-key body is not one public key packet');
  return { assertion, id, key: parsePublicKey(packets[0]!.body) };
}

/** Throws unless `assertion` carries a binary-document signature by `signer` over its content. */
function checkSignature(assertion: Assertion, signer: AccountKey): void {
  if (assertion.headers['sign-key-sha3-384'] !== signer.id) throw new AssertionError(`${assertion.type} is signed by ${assertion.headers['sign-key-sha3-384']}, not ${signer.id}`);
  const packets = readPackets(assertion.signature.subarray(1));
  if (packets.length !== 1 || packets[0]!.tag !== 2) throw new AssertionError(`${assertion.type}: the signature is not one signature packet`);
  const signature = parseSignature(packets[0]!.body);
  if (signature.type !== 0x00) throw new AssertionError(`${assertion.type}: signature type 0x${signature.type.toString(16)}, expected a binary document signature (0x00)`);
  verifySignature(signer.key, signature, assertion.content);
}

const instant = (value: string | undefined, what: string): Date => {
  const date = value ? new Date(value) : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new AssertionError(`${what} "${value}" is not a time`);
  return date;
};

/** The signing key must be in force at `at`: since <= at < until. */
function inForce(signer: AccountKey, at: Date, what: string): void {
  const since = instant(signer.assertion.headers.since, `${signer.id} since`);
  if (at < since) throw new AssertionError(`${what} at ${at.toISOString()} predates its key's since ${since.toISOString()}`);
  const until = signer.assertion.headers.until;
  if (until && at >= instant(until, `${signer.id} until`)) throw new AssertionError(`${what} at ${at.toISOString()} is after its key's until ${until}`);
}

const hexOf = (base64url: string) => Buffer.from(base64url, 'base64url').toString('hex');

/**
 * Checks a snap file against its snap-revision assertion and the assertions that sign it. `stream`
 * holds the snap-revision, the account-key of the key that signed it and optionally the snap's
 * snap-declaration; `rootAccountKey` is the pinned root account-key assertion.
 */
export function verifySnapAssertions(stream: string, trust: TrustAnchors, rootAccountKey: string, file: { sha3_384: string; size: number }, now: Date): Check[] {
  const verifier = SNAP_VERIFIER;
  const anchor = trust.snap;
  let revision: Assertion;
  let declaration: Assertion | undefined;
  let store: AccountKey;
  try {
    const [rootAssertion, ...extra] = parseAssertions(rootAccountKey);
    if (!rootAssertion || extra.length) throw new AssertionError('the pinned root is not exactly one assertion');
    const root = accountKey(rootAssertion);
    if (root.id !== anchor.rootKey.sha3_384) throw new AssertionError(`the root account-key is ${root.id}, not the pinned ${anchor.rootKey.sha3_384}`);
    checkSignature(rootAssertion, root);
    const assertions = parseAssertions(stream);
    const revisions = assertions.filter(assertion => assertion.type === 'snap-revision');
    if (revisions.length !== 1) throw new AssertionError(`expected one snap-revision assertion, found ${revisions.length}`);
    revision = revisions[0]!;
    declaration = assertions.find(assertion => assertion.type === 'snap-declaration');
    const signKey = revision.headers['sign-key-sha3-384'];
    const candidate = assertions.find(assertion => assertion.type === 'account-key' && assertion.headers['public-key-sha3-384'] === signKey);
    if (!candidate) throw new AssertionError(`no account-key assertion for the revision's signing key ${signKey}`);
    store = accountKey(candidate);
    checkSignature(candidate, root);
    if (candidate.headers['authority-id'] !== anchor.authority || candidate.headers['account-id'] !== anchor.authority) {
      throw new AssertionError(`the signing key belongs to ${candidate.headers['account-id']} (authority ${candidate.headers['authority-id']}), not ${anchor.authority}`);
    }
    inForce(root, instant(candidate.headers.since, 'store key since'), 'the store key assertion');
    checkSignature(revision, store);
    inForce(store, instant(revision.headers.timestamp, 'snap-revision timestamp'), 'the snap-revision');
    if (declaration) {
      checkSignature(declaration, store);
      inForce(store, instant(declaration.headers.timestamp, 'snap-declaration timestamp'), 'the snap-declaration');
    }
    if (instant(revision.headers.timestamp, 'snap-revision timestamp') > now) throw new AssertionError(`the snap-revision timestamp ${revision.headers.timestamp} is in the future`);
  } catch (error) {
    if (error instanceof AssertionError || error instanceof OpenPgpError) return [fail('snap.assertion-chain', verifier, error.message)];
    throw error;
  }
  const checks: Check[] = [pass('snap.assertion-chain', verifier, `snap-revision ${revision.headers['snap-revision']} signed by ${store.assertion.headers.name ?? store.id} <- root ${anchor.rootKey.sha3_384.slice(0, 12)}…${declaration ? ', snap-declaration by the same key' : ''}`, {
    revision: revision.headers['snap-revision'], timestamp: revision.headers.timestamp, signKey: store.id,
  })];

  const problems: string[] = [];
  if (revision.headers['authority-id'] !== anchor.authority) problems.push(`authority-id: expected ${anchor.authority}, found ${revision.headers['authority-id']}`);
  if (revision.headers['snap-id'] !== anchor.snapId) problems.push(`snap-id: expected ${anchor.snapId}, found ${revision.headers['snap-id']}`);
  if (revision.headers['developer-id'] !== anchor.developerId) problems.push(`developer-id: expected ${anchor.developerId}, found ${revision.headers['developer-id']}`);
  if (declaration) {
    if (declaration.headers['snap-id'] !== anchor.snapId) problems.push(`snap-declaration snap-id: expected ${anchor.snapId}, found ${declaration.headers['snap-id']}`);
    if (declaration.headers['snap-name'] !== anchor.name) problems.push(`snap-declaration snap-name: expected ${anchor.name}, found ${declaration.headers['snap-name']}`);
    if (declaration.headers['publisher-id'] !== anchor.developerId) problems.push(`snap-declaration publisher-id: expected ${anchor.developerId}, found ${declaration.headers['publisher-id']}`);
  }
  checks.push(problems.length === 0
    ? pass('snap.identity', verifier, `snap-id ${anchor.snapId}, developer ${anchor.developerId}${declaration ? `, name ${anchor.name}` : ''}`)
    : fail('snap.identity', verifier, problems.join('; ')));

  const digest = hexOf(revision.headers['snap-sha3-384'] ?? '');
  const size = Number(revision.headers['snap-size']);
  const mismatches: string[] = [];
  if (digest !== file.sha3_384.toLowerCase()) mismatches.push(`SHA3-384: the assertion states ${digest}, the file has ${file.sha3_384}`);
  if (size !== file.size) mismatches.push(`size: the assertion states ${revision.headers['snap-size']}, the file has ${file.size}`);
  checks.push(mismatches.length === 0
    ? pass('snap.revision-digest', verifier, `SHA3-384 and ${size} bytes equal revision ${revision.headers['snap-revision']}'s assertion`)
    : fail('snap.revision-digest', verifier, mismatches.join('; ')));
  return checks;
}
