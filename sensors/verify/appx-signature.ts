/**
 * The package signature of a Microsoft Store package (AppxSignature.p7x), checked in-process.
 *
 * The file is the magic "PKCX" followed by a DER ContentInfo with an Authenticode-style SignedData.
 * Its SpcIndirectDataContent (with SpcSipInfo) carries a digest that is "APPX" followed by 36-byte
 * records: a 4-byte tag and the SHA-256 of what the tag names (AXPC local file records, AXCD central
 * directory, AXCT content types, AXBM block map, AXCI code integrity catalog). All five are compared
 * with the values readAppxParts computed; the block map in turn hashes every file (verifyAppxPackage).
 * The signer must be the pinned Store publisher and chain, with its timestamp, to the pinned roots.
 */
import { createHash } from 'node:crypto';
import type { TrustAnchors } from '../../lib/trust.ts';
import {
  hashAlgorithm, OID, parseDistinguishedName, parseSignedData, parseSpcIndirectDataContent, sameAttributes, StructureError,
} from '../lib/cms.ts';
import { decodeDer, DerError, hex } from '../lib/der.ts';
import type { AppxParts } from './appx.ts';
import { pinnedCertificates, verifySignatureBlock, type PinnedRoots } from './authenticode.ts';
import { fail, pass, type Check } from './types.ts';

export const APPX_SIGNATURE_VERIFIER = 'svh-appx-signature/1';

const MAGIC = [0x50, 0x4b, 0x43, 0x58]; // "PKCX"
const RECORDS = ['AXPC', 'AXCD', 'AXCT', 'AXBM', 'AXCI'] as const;
type RecordTag = (typeof RECORDS)[number];
const REQUIRED: readonly RecordTag[] = ['AXPC', 'AXCD', 'AXCT', 'AXBM'];

/** The tagged SHA-256 records after the "APPX" magic of the signed digest. */
export function appxDigestRecords(digest: Uint8Array): Map<RecordTag, string> {
  if (digest.length < 4 || Buffer.from(digest.subarray(0, 4)).toString('latin1') !== 'APPX') throw new StructureError('the signed digest does not start with "APPX"');
  if ((digest.length - 4) % 36 !== 0) throw new StructureError(`the signed digest holds ${digest.length - 4} bytes of records, not a multiple of 36`);
  const records = new Map<RecordTag, string>();
  for (let at = 4; at < digest.length; at += 36) {
    const tag = Buffer.from(digest.subarray(at, at + 4)).toString('latin1') as RecordTag;
    if (!RECORDS.includes(tag)) throw new StructureError(`unknown digest record "${tag}"`);
    if (records.has(tag)) throw new StructureError(`the digest record ${tag} appears twice`);
    records.set(tag, hex(digest.subarray(at + 4, at + 36)));
  }
  for (const tag of REQUIRED) if (!records.has(tag)) throw new StructureError(`the signed digest has no ${tag} record`);
  return records;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function verifyAppxSignature(
  p7x: Uint8Array,
  parts: Pick<AppxParts, 'blockMap' | 'contentTypes' | 'codeIntegrity' | 'axpc' | 'axcd'>,
  trust: TrustAnchors,
  certificates: PinnedRoots,
  now = new Date(),
): Check[] {
  const verifier = APPX_SIGNATURE_VERIFIER;
  const checks: Check[] = [];
  let records: Map<RecordTag, string>;
  let signedData: ReturnType<typeof parseSignedData>;
  try {
    if (p7x.length < 4 || MAGIC.some((byte, index) => p7x[index] !== byte)) throw new StructureError('AppxSignature.p7x does not start with "PKCX"');
    signedData = parseSignedData(decodeDer(p7x.subarray(4)), 'package signature');
    if (signedData.contentType !== OID.spcIndirectData || !signedData.content) throw new StructureError(`expected SPC_INDIRECT_DATA content, found ${signedData.contentType}`);
    const indirect = parseSpcIndirectDataContent(signedData.content);
    if (indirect.dataType !== OID.spcSipInfo) throw new StructureError(`expected SpcSipInfo (${OID.spcSipInfo}), found ${indirect.dataType}`);
    const algorithm = hashAlgorithm(indirect.digestAlgorithm, 'package digest algorithm');
    if (algorithm !== 'sha256') throw new StructureError(`the package digest algorithm is ${algorithm}, expected sha256`);
    records = appxDigestRecords(indirect.digest);
    checks.push(pass('appx.signature-structure', verifier, `PKCX signature with ${[...records.keys()].join(', ')} digest records`, { embeddedCertificates: signedData.certificates.length }));
  } catch (error) {
    if (error instanceof DerError || error instanceof StructureError) return [fail('appx.signature-structure', verifier, error.message)];
    throw error;
  }

  const actual: Partial<Record<RecordTag, string>> = {
    AXPC: parts.axpc, AXCD: parts.axcd, AXCT: sha256(parts.contentTypes), AXBM: sha256(parts.blockMap),
    ...(parts.codeIntegrity ? { AXCI: sha256(parts.codeIntegrity) } : {}),
  };
  const problems: string[] = [];
  for (const tag of RECORDS) {
    const signed = records.get(tag);
    const computed = actual[tag];
    if (signed === undefined && computed === undefined) continue;
    if (signed === undefined) problems.push(`the package has the part ${tag} covers, but the signature has no ${tag} record`);
    else if (computed === undefined) problems.push(`the signature has a ${tag} record, but the package lacks the part it covers`);
    else if (signed !== computed) problems.push(`${tag}: signed ${signed}, computed ${computed}`);
  }
  checks.push(problems.length === 0
    ? pass('appx.content-digests', verifier, `${[...records.keys()].join(', ')} equal the package's zip records, content types, block map and code integrity catalog`, { records: Object.fromEntries(records) })
    : fail('appx.content-digests', verifier, problems.join('; ')));

  const anchor = trust.windowsStore;
  try {
    const block = verifySignatureBlock(signedData, {
      family: 'appx', verifier,
      roots: pinnedCertificates(certificates.roots), timestampRoots: pinnedCertificates(certificates.timestampRoots),
      purpose: OID.codeSigning, now,
    });
    checks.push(...block.checks);
    checks.push(sameAttributes(block.certificate.subject.attributes, parseDistinguishedName(anchor.publisher))
      ? pass('appx.signer', verifier, `"${block.certificate.subject.text}" issued by "${block.certificate.issuer.text}"`, { subject: block.certificate.subject.text, issuer: block.certificate.issuer.text, certificateSha256: block.certificate.sha256 })
      : fail('appx.signer', verifier, `expected the publisher "${anchor.publisher}", found "${block.certificate.subject.text}"`));
  } catch (error) {
    if (error instanceof DerError || error instanceof StructureError) return [...checks, fail('appx.signature', verifier, error.message)];
    throw error;
  }
  return checks;
}
