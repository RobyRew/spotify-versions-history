/**
 * Authenticode signatures of Windows PE files, checked in-process with Node's crypto (sensors/lib/cms.ts).
 *
 * The certificate table holds one WIN_CERTIFICATE (revision 0x0200, type PKCS_SIGNED_DATA) with a
 * SignedData whose content is an SpcIndirectDataContent naming the PE image hash. The image hash
 * covers every byte of the file except the optional header's CheckSum, the security data directory
 * entry and the certificate table itself; it is computed by streaming those ranges from disk.
 *
 * The signer must carry the pinned subject attributes and issuer (ledger/trust/anchors.json), chain
 * to a pinned root at the signing time, and carry an RFC 3161 timestamp (or PKCS #9 countersignature)
 * chaining to a pinned timestamp root. Nested signatures (szOID_NESTED_SIGNATURE) are checked the
 * same way and reported in one row.
 */
import { createHash, type X509Certificate } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { TrustAnchors } from '../../lib/trust.ts';
import {
  ATTRIBUTE_OIDS, attributes, buildChain, hashAlgorithm, isHashName, OID, parseCertificate, parseDistinguishedName, parseSignedData,
  parseSpcIndirectDataContent, sameAttributes, signerCertificate, StructureError, verifySigner, verifyTimestamp,
  type Certificate, type HashName, type SignedData,
} from '../lib/cms.ts';
import { DerError, hex, readElement, type DerElement } from '../lib/der.ts';
import { parsePeHeaders, type PeLayout } from '../lib/pe.ts';
import { fail, pass, type Check } from './types.ts';

export const AUTHENTICODE_VERIFIER = 'svh-authenticode/1';

/** Pinned roots as X509Certificate objects, the form loadCertificates returns. */
export interface PinnedRoots {
  roots: readonly X509Certificate[];
  timestampRoots: readonly X509Certificate[];
}

const HEADER_BYTES = 4096;
/** Spotify's certificate tables are about 10 KB; a table past this size is not one of them. */
const MAX_CERTIFICATE_TABLE = 1024 * 1024;
const WIN_CERT_REVISION_2_0 = 0x0200;
const WIN_CERT_TYPE_PKCS_SIGNED_DATA = 0x0002;

export function pinnedCertificates(certificates: readonly X509Certificate[]): Certificate[] {
  return certificates.map(certificate => parseCertificate(new Uint8Array(certificate.raw)));
}

const iso = (date: Date) => date.toISOString().replace('.000Z', 'Z');

export interface SignatureBlockResult {
  certificate: Certificate;
  signingTime: Date;
  checks: Check[];
}

/**
 * Checks the one SignerInfo of an Authenticode-style SignedData (PE files and Store packages): the
 * signature over the signed attributes, the timestamp, and the chain at the signing time. Emits
 * `<family>.signature`, `<family>.timestamp` and `<family>.chain` rows. Throws StructureError or
 * DerError for a structure that cannot be read, for the caller to report.
 */
export function verifySignatureBlock(signedData: SignedData, options: {
  family: string;
  verifier: string;
  roots: readonly Certificate[];
  timestampRoots: readonly Certificate[];
  purpose: string;
  now: Date;
}): SignatureBlockResult {
  const { family, verifier, now } = options;
  if (signedData.contentType !== OID.spcIndirectData) throw new StructureError(`expected the content type SPC_INDIRECT_DATA (${OID.spcIndirectData}), found ${signedData.contentType}`);
  if (!signedData.signedContent) throw new StructureError('the SignedData carries no content');
  if (signedData.signerInfos.length !== 1) throw new StructureError(`expected one SignerInfo, found ${signedData.signerInfos.length}`);
  const signer = signedData.signerInfos[0]!;
  const certificate = signerCertificate(signer, signedData.certificates);
  const checks: Check[] = [];

  const signed = verifySigner(signer, certificate, {
    content: signedData.signedContent,
    contentType: OID.spcIndirectData,
    digestAlgorithms: signedData.digestAlgorithms.map(algorithm => algorithm.oid),
  });
  checks.push(signed.problems.length === 0
    ? pass(`${family}.signature`, verifier, `${signed.signatureScheme} by "${certificate.subject.text}"`, { scheme: signed.signatureScheme, messageDigest: signed.messageDigest })
    : fail(`${family}.signature`, verifier, signed.problems.join('; '), { signer: certificate.subject.text }));

  const timestamp = verifyTimestamp(signer, signedData, options.timestampRoots, now);
  let signingTime = now;
  if (!timestamp) {
    checks.push(fail(`${family}.timestamp`, verifier, 'expected a timestamp, found none: without one the signature is valid only while the signing certificate is'));
  } else if (timestamp.problems.length) {
    checks.push(fail(`${family}.timestamp`, verifier, timestamp.problems.join('; '), { kind: timestamp.kind, tsa: timestamp.signer?.subject.text ?? null }));
  } else {
    signingTime = timestamp.time!;
    checks.push(pass(`${family}.timestamp`, verifier, `${timestamp.kind} timestamp ${iso(signingTime)} by "${timestamp.signer!.subject.text}"`, {
      kind: timestamp.kind, time: signingTime.toISOString(), tsa: timestamp.signer!.subject.text,
      chain: timestamp.chain.map(link => link.subject.text), digestAlgorithm: timestamp.digestAlgorithm,
    }));
  }

  const chain = buildChain(certificate, { pool: signedData.certificates, roots: options.roots, at: signingTime, purpose: options.purpose });
  const subjects = chain.chain.map(link => link.subject.text);
  checks.push(chain.ok
    ? pass(`${family}.chain`, verifier, subjects.join(' <- '), { chain: subjects, at: signingTime.toISOString() })
    : fail(`${family}.chain`, verifier, chain.problem, { chain: subjects }));
  return { certificate, signingTime, checks };
}

/** The pinned signer identity: every attribute of `expected` present with an equal value. */
export function subjectProblems(certificate: Certificate, expected: Readonly<Record<string, string>>): string[] {
  const problems: string[] = [];
  for (const [label, value] of Object.entries(expected)) {
    const id = ATTRIBUTE_OIDS[label];
    if (!id) { problems.push(`the pinned subject attribute "${label}" has no known OID`); continue; }
    const found = certificate.subject.attributes.filter(attribute => attribute.oid === id).map(attribute => attribute.value);
    if (!found.includes(value)) problems.push(`subject ${label}: expected "${value}", found ${found.length ? found.map(item => `"${item}"`).join(', ') : 'none'}`);
  }
  return problems;
}

interface WinCertificate {
  revision: number;
  type: number;
  /** The DER of the SignedData ContentInfo, without the zero padding that may follow it. */
  signedData: DerElement;
}

/** The entries of an Authenticode certificate table; each starts on an 8-byte boundary. */
export function parseCertificateTable(table: Uint8Array): WinCertificate[] {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const entries: WinCertificate[] = [];
  let at = 0;
  while (at < table.length) {
    if (at + 8 > table.length) throw new StructureError(`the certificate table ends ${table.length - at} bytes into a WIN_CERTIFICATE header`);
    const length = view.getUint32(at, true);
    const revision = view.getUint16(at + 4, true);
    const type = view.getUint16(at + 6, true);
    if (length < 8 || at + length > table.length) throw new StructureError(`a WIN_CERTIFICATE at table offset ${at} claims ${length} bytes, the table has ${table.length - at} left`);
    const body = table.subarray(at + 8, at + length);
    const element = readElement(body, 0, body.length);
    const padding = body.subarray(element.end);
    if (padding.some(byte => byte !== 0)) throw new StructureError(`${padding.length} non-zero bytes follow the SignedData in the WIN_CERTIFICATE at table offset ${at}`);
    entries.push({ revision, type, signedData: element });
    at += Math.ceil(length / 8) * 8;
  }
  return entries;
}

/** Byte ranges [start, end) of the file that the Authenticode image hash covers. */
export function imageRanges(layout: PeLayout, fileSize: number): [number, number][] {
  if (!layout.certificate) throw new StructureError('the file has no certificate table');
  const excluded: [number, number][] = [
    [layout.checksumOffset, layout.checksumOffset + 4],
    [layout.securityDirectoryOffset, layout.securityDirectoryOffset + 8],
    [layout.certificate.offset, layout.certificate.offset + layout.certificate.size],
  ].sort((a, b) => a[0]! - b[0]!) as [number, number][];
  const ranges: [number, number][] = [];
  let at = 0;
  for (const [start, end] of excluded) {
    if (start < at) throw new StructureError(`excluded ranges overlap at offset ${start}`);
    if (end > fileSize) throw new StructureError(`an excluded range ends at ${end}, past the end of the file (${fileSize} bytes)`);
    if (start > at) ranges.push([at, start]);
    at = end;
  }
  if (at < fileSize) ranges.push([at, fileSize]);
  return ranges;
}

/** Streams the given ranges of `file` through one hash per algorithm. */
export async function hashRanges(file: string, ranges: readonly [number, number][], algorithms: readonly HashName[]): Promise<Map<HashName, string>> {
  const hashes = new Map(algorithms.map(algorithm => [algorithm, createHash(algorithm)]));
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    for await (const chunk of createReadStream(file, { start, end: end - 1, highWaterMark: 1 << 20 })) {
      for (const hash of hashes.values()) hash.update(chunk as Buffer);
    }
  }
  return new Map([...hashes].map(([algorithm, hash]) => [algorithm, hash.digest('hex')]));
}

interface ParsedSignature {
  signedData: SignedData;
  imageHash: HashName;
  imageDigest: string;
}

function parsePeSignature(element: DerElement, what: string): ParsedSignature {
  const signedData = parseSignedData(element, what);
  if (signedData.contentType !== OID.spcIndirectData || !signedData.content) throw new StructureError(`${what}: expected SPC_INDIRECT_DATA content, found ${signedData.contentType}`);
  const indirect = parseSpcIndirectDataContent(signedData.content);
  if (indirect.dataType !== OID.spcPeImageData) throw new StructureError(`${what}: expected SpcPeImageData (${OID.spcPeImageData}), found ${indirect.dataType}`);
  const named = hashAlgorithm(indirect.digestAlgorithm, `${what} image digest algorithm`, { allowSha1: true });
  if (!isHashName(named)) throw new StructureError(named);
  return { signedData, imageHash: named, imageDigest: hex(indirect.digest) };
}

/**
 * Verifies the Authenticode signature of the PE file at `file`. Returns one row per aspect; a file
 * that cannot be read as a signed PE yields a failed authenticode.structure row and nothing else.
 */
export async function verifyAuthenticode(file: string, trust: TrustAnchors, certificates: PinnedRoots, now = new Date()): Promise<Check[]> {
  const verifier = AUTHENTICODE_VERIFIER;
  const anchor = trust.windows.authenticode;
  let fileSize: number;
  let layout: PeLayout;
  let table: Uint8Array;
  const handle = await open(file, 'r');
  try {
    fileSize = (await handle.stat()).size;
    const head = new Uint8Array(Math.min(HEADER_BYTES, fileSize));
    await handle.read(head, 0, head.length, 0);
    try {
      layout = parsePeHeaders(head);
    } catch (error) {
      return [fail('authenticode.structure', verifier, `not a readable PE file: ${(error as Error).message}`)];
    }
    if (!layout.certificate) return [fail('authenticode.structure', verifier, 'expected an Authenticode certificate table, found none: the file is not signed')];
    const { offset, size } = layout.certificate;
    if (size > MAX_CERTIFICATE_TABLE || offset < head.length || offset + size > fileSize) {
      return [fail('authenticode.structure', verifier, `the certificate table at ${offset} (${size} bytes) is not inside the ${fileSize}-byte file past its headers, or is larger than ${MAX_CERTIFICATE_TABLE} bytes`)];
    }
    table = new Uint8Array(size);
    const { bytesRead } = await handle.read(table, 0, size, offset);
    if (bytesRead !== size) return [fail('authenticode.structure', verifier, `read ${bytesRead} of the certificate table's ${size} bytes`)];
  } finally {
    await handle.close();
  }

  let primary: ParsedSignature;
  let ranges: [number, number][];
  const checks: Check[] = [];
  try {
    const entries = parseCertificateTable(table);
    if (entries.length !== 1) throw new StructureError(`expected one WIN_CERTIFICATE, found ${entries.length}`);
    const entry = entries[0]!;
    if (entry.revision !== WIN_CERT_REVISION_2_0 || entry.type !== WIN_CERT_TYPE_PKCS_SIGNED_DATA) {
      throw new StructureError(`expected WIN_CERTIFICATE revision 0x0200 type PKCS_SIGNED_DATA (2), found revision 0x${entry.revision.toString(16)} type ${entry.type}`);
    }
    primary = parsePeSignature(entry.signedData, 'Authenticode signature');
    ranges = imageRanges(layout, fileSize);
    const trailing = fileSize - (layout.certificate!.offset + layout.certificate!.size);
    checks.push(pass('authenticode.structure', verifier, `one PKCS #7 WIN_CERTIFICATE of ${table.length} bytes at offset ${layout.certificate!.offset}`, {
      certificateTable: layout.certificate, bytesAfterTable: trailing, embeddedCertificates: primary.signedData.certificates.length,
    }));
  } catch (error) {
    if (error instanceof DerError || error instanceof StructureError) return [fail('authenticode.structure', verifier, error.message)];
    throw error;
  }

  const roots = pinnedCertificates(certificates.roots);
  const timestampRoots = pinnedCertificates(certificates.timestampRoots);
  const nested: ParsedSignature[] = [];
  const nestedProblems: string[] = [];
  for (const attribute of attributes(primary.signedData.signerInfos[0]?.unsignedAttributes ?? null, OID.nestedSignature)) {
    for (const value of attribute.values) {
      try { nested.push(parsePeSignature(value, 'nested signature')); }
      catch (error) {
        if (error instanceof DerError || error instanceof StructureError) nestedProblems.push(error.message);
        else throw error;
      }
    }
  }

  const algorithms = [...new Set([primary.imageHash, ...nested.map(signature => signature.imageHash)])];
  const digests = await hashRanges(file, ranges, algorithms);
  const actual = digests.get(primary.imageHash)!;
  checks.push(actual === primary.imageDigest
    ? pass('authenticode.image-digest', verifier, `${primary.imageHash} image digest ${actual} equals the signed one`, { algorithm: primary.imageHash, digest: actual })
    : fail('authenticode.image-digest', verifier, `expected the signed ${primary.imageHash} image digest ${primary.imageDigest}, computed ${actual}: the file differs from what was signed`));

  let block: SignatureBlockResult;
  try {
    block = verifySignatureBlock(primary.signedData, { family: 'authenticode', verifier, roots, timestampRoots, purpose: OID.codeSigning, now });
  } catch (error) {
    if (error instanceof DerError || error instanceof StructureError) return [...checks, fail('authenticode.signature', verifier, error.message)];
    throw error;
  }
  checks.push(...block.checks);

  const problems = subjectProblems(block.certificate, anchor.subject);
  const pinnedIssuer = parseDistinguishedName(anchor.issuer);
  if (!sameAttributes(block.certificate.issuer.attributes, pinnedIssuer)) problems.push(`issuer: expected "${anchor.issuer}", found "${block.certificate.issuer.text}"`);
  checks.push(problems.length === 0
    ? pass('authenticode.signer', verifier, `"${block.certificate.subject.text}" issued by "${block.certificate.issuer.text}"`, {
      subject: block.certificate.subject.text, issuer: block.certificate.issuer.text, serialNumber: hex(block.certificate.serialNumber).toUpperCase(),
      certificateSha256: block.certificate.sha256, notBefore: block.certificate.notBefore.toISOString(), notAfter: block.certificate.notAfter.toISOString(),
    })
    : fail('authenticode.signer', verifier, problems.join('; '), { subject: block.certificate.subject.text, issuer: block.certificate.issuer.text }));

  if (nested.length || nestedProblems.length) {
    for (const signature of nested) {
      const digest = digests.get(signature.imageHash)!;
      if (digest !== signature.imageDigest) nestedProblems.push(`nested ${signature.imageHash} image digest: expected ${signature.imageDigest}, computed ${digest}`);
      try {
        const result = verifySignatureBlock(signature.signedData, { family: 'nested', verifier, roots, timestampRoots, purpose: OID.codeSigning, now });
        for (const check of result.checks) if (check.status === 'fail') nestedProblems.push(`${check.id}: ${check.detail}`);
        nestedProblems.push(...subjectProblems(result.certificate, anchor.subject).map(problem => `nested signer ${problem}`));
      } catch (error) {
        if (error instanceof DerError || error instanceof StructureError) nestedProblems.push(error.message);
        else throw error;
      }
    }
    checks.push(nestedProblems.length === 0
      ? pass('authenticode.nested', verifier, `${nested.length} nested signature(s) verify`, { algorithms: nested.map(signature => signature.imageHash) })
      : fail('authenticode.nested', verifier, nestedProblems.join('; ')));
  }
  return checks;
}
