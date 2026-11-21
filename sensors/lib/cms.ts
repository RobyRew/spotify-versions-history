/**
 * CMS SignedData (RFC 5652) as Authenticode, the Microsoft Store's AppxSignature.p7x and RFC 3161
 * timestamps use it, checked with Node's crypto only:
 *  - parsing of ContentInfo, SignedData, SignerInfo, X.509 certificates and distinguished names with
 *    the strict DER reader (der.ts);
 *  - signer verification: the signed attributes as their DER with the [0] tag replaced by SET OF
 *    (0x31), the contentType and messageDigest attributes, the signature with the signer
 *    certificate's key (RSA PKCS #1 v1.5, RSA-PSS, ECDSA);
 *  - chain building from a signer certificate through the embedded certificates to pinned roots, with
 *    validity at the signing time, CA constraints and extended key usage;
 *  - timestamps: RFC 3161 tokens (unsigned attribute 1.3.6.1.4.1.311.3.3.1) and PKCS #9
 *    countersignatures (1.2.840.113549.1.9.6).
 *
 * Structural problems throw a DerError or StructureError for the caller to turn into a failed check;
 * verification problems are returned as sentences saying what was expected and what was found.
 */
import { constants, createHash, verify as cryptoVerify, X509Certificate, type KeyObject } from 'node:crypto';
import {
  boolean, bytesEqual, CLASS, DerElement, DerError, decodeDer, expectTag, hex, integer, octetString, oid,
  sequence, set, smallInteger, string, TAG, time,
} from './der.ts';

/** A signature structure that is valid DER but not what the format requires. */
export class StructureError extends Error {
  override name = 'StructureError';
}

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  counterSignature: '1.2.840.113549.1.9.6',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  signingCertificate: '1.2.840.113549.1.9.16.2.12',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  /** szOID_RFC3161_counterSign: an RFC 3161 timestamp token in an Authenticode unsigned attribute. */
  rfc3161Timestamp: '1.3.6.1.4.1.311.3.3.1',
  /** szOID_NESTED_SIGNATURE: further Authenticode signatures in the primary signer's unsigned attributes. */
  nestedSignature: '1.3.6.1.4.1.311.2.4.1',
  spcIndirectData: '1.3.6.1.4.1.311.2.1.4',
  spcPeImageData: '1.3.6.1.4.1.311.2.1.15',
  spcSipInfo: '1.3.6.1.4.1.311.2.1.30',
  codeSigning: '1.3.6.1.5.5.7.3.3',
  timeStamping: '1.3.6.1.5.5.7.3.8',
  anyExtendedKeyUsage: '2.5.29.37.0',
  rsaEncryption: '1.2.840.113549.1.1.1',
  rsassaPss: '1.2.840.113549.1.1.10',
  mgf1: '1.2.840.113549.1.1.8',
  ecPublicKey: '1.2.840.10045.2.1',
} as const;

export type HashName = 'sha1' | 'sha256' | 'sha384' | 'sha512';

const HASH_OIDS: Readonly<Record<string, HashName>> = {
  '1.3.14.3.2.26': 'sha1',
  '2.16.840.1.101.3.4.2.1': 'sha256',
  '2.16.840.1.101.3.4.2.2': 'sha384',
  '2.16.840.1.101.3.4.2.3': 'sha512',
};
export const HASH_LENGTH: Readonly<Record<HashName, number>> = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 };
/** Tells a hashAlgorithm() result that names a hash from one that is a problem sentence (both are strings). */
export const isHashName = (value: string): value is HashName => Object.hasOwn(HASH_LENGTH, value);
/**
 * Hashes accepted for content digests, image digests and signatures. SHA-1 (collisions since 2017) and
 * MD5 are refused; SHA-1 is read only where a format fixes it, as in the ESS signingCertificate binding.
 */
const ACCEPTED_HASHES: ReadonlySet<HashName> = new Set<HashName>(['sha256', 'sha384', 'sha512']);

const RSA_PKCS1: Readonly<Record<string, HashName | null>> = {
  [OID.rsaEncryption]: null,
  '1.2.840.113549.1.1.11': 'sha256',
  '1.2.840.113549.1.1.12': 'sha384',
  '1.2.840.113549.1.1.13': 'sha512',
};
const ECDSA: Readonly<Record<string, HashName | null>> = {
  [OID.ecPublicKey]: null,
  '1.2.840.10045.4.3.2': 'sha256',
  '1.2.840.10045.4.3.3': 'sha384',
  '1.2.840.10045.4.3.4': 'sha512',
};
/** Certificate signature algorithms refused below a pinned root: MD5 and SHA-1 based. */
const WEAK_CERTIFICATE_SIGNATURES: ReadonlySet<string> = new Set([
  '1.2.840.113549.1.1.4', '1.2.840.113549.1.1.5', '1.2.840.10045.4.1', '1.2.840.10040.4.3', '1.3.14.3.2.29',
]);

export interface AlgorithmIdentifier {
  oid: string;
  parameters: DerElement | null;
}

export function parseAlgorithm(element: DerElement, what: string): AlgorithmIdentifier {
  const [algorithm, parameters, ...rest] = sequence(element, what);
  if (!algorithm || rest.length) throw new StructureError(`${what}: an AlgorithmIdentifier holds an OID and at most one parameter`);
  return { oid: oid(algorithm, what), parameters: parameters ?? null };
}

const hasNoParameters = (algorithm: AlgorithmIdentifier) =>
  algorithm.parameters === null || (algorithm.parameters.isUniversal(TAG.null) && algorithm.parameters.length === 0);

/** The hash an AlgorithmIdentifier names, or a sentence saying why it is not accepted. */
export function hashAlgorithm(algorithm: AlgorithmIdentifier, what: string, options: { allowSha1?: boolean } = {}): HashName | string {
  const name = HASH_OIDS[algorithm.oid];
  if (!name) return `${what}: expected SHA-256, SHA-384 or SHA-512, found the algorithm ${algorithm.oid}`;
  if (!ACCEPTED_HASHES.has(name) && !(options.allowSha1 && name === 'sha1')) return `${what}: ${name.toUpperCase()} is not accepted (expected SHA-256, SHA-384 or SHA-512)`;
  if (!hasNoParameters(algorithm)) return `${what}: ${name} has unexpected parameters`;
  return name;
}

export function digest(hash: HashName, ...parts: Uint8Array[]): Uint8Array {
  const hasher = createHash(hash);
  for (const part of parts) hasher.update(part);
  return new Uint8Array(hasher.digest());
}

// ---------------------------------------------------------------------------------------------
// Distinguished names

/** Attribute long names (as trust anchors write them) and the OIDs they stand for. */
export const ATTRIBUTE_OIDS: Readonly<Record<string, string>> = {
  CN: '2.5.4.3',
  surname: '2.5.4.4',
  serialNumber: '2.5.4.5',
  C: '2.5.4.6',
  L: '2.5.4.7',
  S: '2.5.4.8',
  ST: '2.5.4.8',
  street: '2.5.4.9',
  O: '2.5.4.10',
  OU: '2.5.4.11',
  title: '2.5.4.12',
  businessCategory: '2.5.4.15',
  postalCode: '2.5.4.17',
  jurisdictionLocalityName: '1.3.6.1.4.1.311.60.2.1.1',
  jurisdictionStateOrProvinceName: '1.3.6.1.4.1.311.60.2.1.2',
  jurisdictionCountryName: '1.3.6.1.4.1.311.60.2.1.3',
  E: '1.2.840.113549.1.9.1',
  emailAddress: '1.2.840.113549.1.9.1',
  DC: '0.9.2342.19200300.100.1.25',
  UID: '0.9.2342.19200300.100.1.1',
};

/** How names print an attribute: the first long name of each OID above ("S" as Windows writes it). */
const ATTRIBUTE_LABELS: Readonly<Record<string, string>> = (() => {
  const labels: Record<string, string> = {};
  for (const [label, id] of Object.entries(ATTRIBUTE_OIDS)) labels[id] ??= label;
  return labels;
})();

const LOWERCASE_LABELS: ReadonlyMap<string, string> = new Map(Object.entries(ATTRIBUTE_OIDS).map(([label, id]) => [label.toLowerCase(), id]));

export interface NameAttribute {
  oid: string;
  label: string;
  value: string;
}

export interface Name {
  /** The Name's full DER encoding, compared byte for byte when chaining certificates. */
  der: Uint8Array;
  /** Relative distinguished names in encoding order (country first for most CAs). */
  rdns: NameAttribute[][];
  attributes: NameAttribute[];
  /** "CN=..., O=..., C=US": the RDNs last to first, as Windows and the trust anchors print them. */
  text: string;
}

export function parseName(element: DerElement, what: string): Name {
  const rdns = sequence(element, what).map(rdn => {
    const values = set(rdn, `${what} RDN`);
    if (values.length === 0) throw new StructureError(`${what}: empty relative distinguished name`);
    return values.map(pair => {
      const [type, value, ...rest] = sequence(pair, `${what} attribute`);
      if (!type || !value || rest.length) throw new StructureError(`${what}: an attribute is not a type and a value`);
      const id = oid(type, `${what} attribute type`);
      let text: string;
      try { text = string(value, `${what} ${id}`); } catch { text = `#${hex(value.encoding)}`; }
      return { oid: id, label: ATTRIBUTE_LABELS[id] ?? id, value: text };
    });
  });
  return { der: element.encoding, rdns, attributes: rdns.flat(), text: formatRdns(rdns) };
}

function formatRdns(rdns: NameAttribute[][]): string {
  return [...rdns].reverse().map(rdn => rdn.map(attribute => `${attribute.label}=${attribute.value}`).join(' + ')).join(', ');
}

const ATTRIBUTE_START = /^\s*(?:[A-Za-z][A-Za-z0-9-]*|\d+(?:\.\d+)+)\s*=/;

/**
 * Reads a distinguished name written as in the trust anchors: "CN=..., O=DigiCert, Inc., C=US". A comma
 * separates attributes only when another "type=" follows it, so values may hold unescaped commas;
 * RFC 4514 backslash escapes are honoured. Throws for an attribute type it has no OID for.
 */
export function parseDistinguishedName(text: string): { oid: string; label: string; value: string }[] {
  const parts: string[] = [];
  let current = '';
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === '\\' && at + 1 < text.length) {
      current += char + text[at + 1]!;
      at++;
    } else if ((char === ',' || char === '+') && ATTRIBUTE_START.test(text.slice(at + 1))) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.map(part => {
    const equals = part.indexOf('=');
    if (equals < 0) throw new StructureError(`"${part.trim()}" in the name "${text}" is not type=value`);
    const type = part.slice(0, equals).trim();
    const id = /^\d+(\.\d+)+$/.test(type) ? type : LOWERCASE_LABELS.get(type.toLowerCase());
    if (!id) throw new StructureError(`the name "${text}" uses the attribute type "${type}", which has no known OID`);
    const value = part.slice(equals + 1).trim().replace(/\\([0-9A-Fa-f]{2}|.)/g, (_, escaped: string) =>
      escaped.length === 2 ? String.fromCharCode(Number.parseInt(escaped, 16)) : escaped);
    return { oid: id, label: ATTRIBUTE_LABELS[id] ?? id, value };
  });
}

/** Equality of two names as attribute multisets, ignoring the order they are written in. */
export function sameAttributes(a: readonly { oid: string; value: string }[], b: readonly { oid: string; value: string }[]): boolean {
  const key = (list: readonly { oid: string; value: string }[]) => list.map(item => `${item.oid}\u0000${item.value}`).sort();
  const left = key(a);
  const right = key(b);
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

// ---------------------------------------------------------------------------------------------
// X.509 certificates

const KEY_USAGE_BITS = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'] as const;
export type KeyUsage = (typeof KEY_USAGE_BITS)[number];

const EXTENSION = {
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  basicConstraints: '2.5.29.19',
  certificatePolicies: '2.5.29.32',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  /**
   * szOID_APPLICATION_CERT_POLICIES: Microsoft's application policies, a list of purposes that
   * CryptoAPI intersects with the extended key usage. Microsoft Store signing certificates mark it
   * critical; the chain check requires the purpose in it as in the extended key usage.
   */
  applicationPolicies: '1.3.6.1.4.1.311.21.10',
} as const;
/**
 * Extensions this verifier reads or that do not restrict what it checks; any other extension marked
 * critical makes a chain fail (RFC 5280 section 4.2).
 */
const UNDERSTOOD_EXTENSIONS: ReadonlySet<string> = new Set(Object.values(EXTENSION));

export interface Extension {
  oid: string;
  critical: boolean;
  value: Uint8Array;
}

export interface Certificate {
  x509: X509Certificate;
  der: Uint8Array;
  /** SHA-256 of the DER, upper-case hex: the notation of ledger/trust/anchors.json. */
  sha256: string;
  serialNumber: Uint8Array;
  issuer: Name;
  subject: Name;
  notBefore: Date;
  notAfter: Date;
  /** OID of the outer signatureAlgorithm, which must equal the TBSCertificate's. */
  signatureAlgorithm: string;
  extensions: Extension[];
  basicConstraints: { ca: boolean; pathLength: number | null } | null;
  keyUsage: ReadonlySet<KeyUsage> | null;
  extendedKeyUsage: { purposes: string[]; critical: boolean } | null;
  /** Purposes of the Microsoft application policies extension, when the certificate has it. */
  applicationPolicies: string[] | null;
  subjectKeyIdentifier: Uint8Array | null;
}

export function parseCertificate(der: Uint8Array): Certificate {
  const certificate = decodeDer(der);
  const [tbs, outerAlgorithm, signatureValue, ...extra] = sequence(certificate, 'Certificate');
  if (!tbs || !outerAlgorithm || !signatureValue || extra.length) throw new StructureError('Certificate: expected tbsCertificate, signatureAlgorithm and signatureValue');
  const fields = sequence(tbs, 'TBSCertificate');
  let index = 0;
  let version = 0;
  if (fields[0]?.isContext(0)) {
    const [inner, ...more] = fields[0].children();
    if (!inner || more.length) throw new StructureError('TBSCertificate: malformed version');
    version = smallInteger(inner, 'TBSCertificate version');
    index++;
  }
  const [serial, innerAlgorithm, issuer, validity, subject, publicKeyInfo] = fields.slice(index, index + 6);
  if (!serial || !innerAlgorithm || !issuer || !validity || !subject || !publicKeyInfo) throw new StructureError('TBSCertificate: missing fields');
  expectTag(publicKeyInfo, CLASS.universal, TAG.sequence, 'subjectPublicKeyInfo');
  const outer = parseAlgorithm(outerAlgorithm, 'Certificate signatureAlgorithm');
  const inner = parseAlgorithm(innerAlgorithm, 'TBSCertificate signature');
  if (!bytesEqual(outerAlgorithm.encoding, innerAlgorithm.encoding)) {
    throw new StructureError(`Certificate: signatureAlgorithm ${outer.oid} differs from the TBSCertificate's ${inner.oid}`);
  }
  const [notBefore, notAfter, ...validityExtra] = sequence(validity, 'Validity');
  if (!notBefore || !notAfter || validityExtra.length) throw new StructureError('Validity: expected notBefore and notAfter');
  const extensions: Extension[] = [];
  for (const field of fields.slice(index + 6)) {
    if (field.isContext(1) || field.isContext(2)) continue; // issuerUniqueID, subjectUniqueID
    if (!field.isContext(3) || version !== 2) throw new StructureError(`TBSCertificate: unexpected ${field.label} field`);
    const [list, ...more] = field.children();
    if (!list || more.length) throw new StructureError('TBSCertificate: malformed extensions');
    for (const item of sequence(list, 'Extensions')) {
      const parts = sequence(item, 'Extension');
      const id = oid(parts[0] ?? item, 'Extension extnID');
      let critical = false;
      let valueElement = parts[1];
      if (valueElement?.isUniversal(TAG.boolean)) {
        critical = boolean(valueElement, `Extension ${id} critical`);
        valueElement = parts[2];
        if (parts.length !== 3) throw new StructureError(`Extension ${id}: unexpected fields`);
      } else if (parts.length !== 2) {
        throw new StructureError(`Extension ${id}: unexpected fields`);
      }
      if (!valueElement) throw new StructureError(`Extension ${id}: no extnValue`);
      if (extensions.some(extension => extension.oid === id)) throw new StructureError(`Certificate: extension ${id} appears twice`);
      extensions.push({ oid: id, critical, value: octetString(valueElement, `Extension ${id} extnValue`) });
    }
  }
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(Buffer.from(der.buffer, der.byteOffset, der.byteLength));
  } catch (error) {
    throw new StructureError(`Certificate: Node's X509Certificate refused it: ${error instanceof Error ? error.message : String(error)}`);
  }
  const extension = (id: string) => extensions.find(item => item.oid === id);
  return {
    x509,
    der,
    sha256: createHash('sha256').update(der).digest('hex').toUpperCase(),
    serialNumber: integer(serial, 'serialNumber'),
    issuer: parseName(issuer, 'issuer'),
    subject: parseName(subject, 'subject'),
    notBefore: time(notBefore, 'notBefore'),
    notAfter: time(notAfter, 'notAfter'),
    signatureAlgorithm: outer.oid,
    extensions,
    basicConstraints: parseBasicConstraints(extension(EXTENSION.basicConstraints)),
    keyUsage: parseKeyUsage(extension(EXTENSION.keyUsage)),
    extendedKeyUsage: parseExtendedKeyUsage(extension(EXTENSION.extKeyUsage)),
    applicationPolicies: parseApplicationPolicies(extension(EXTENSION.applicationPolicies)),
    subjectKeyIdentifier: parseSubjectKeyIdentifier(extension(EXTENSION.subjectKeyIdentifier)),
  };
}

/** CertificatePolicies syntax (RFC 5280 4.2.1.4): SEQUENCE OF { policyIdentifier, policyQualifiers OPTIONAL }. */
function parseApplicationPolicies(extension: Extension | undefined): string[] | null {
  if (!extension) return null;
  const policies = sequence(decodeDer(extension.value), 'application policies').map(item => {
    const [identifier] = sequence(item, 'PolicyInformation');
    if (!identifier) throw new StructureError('PolicyInformation: no policyIdentifier');
    return oid(identifier, 'policyIdentifier');
  });
  if (policies.length === 0) throw new StructureError('application policies: empty');
  return policies;
}

function parseBasicConstraints(extension: Extension | undefined): Certificate['basicConstraints'] {
  if (!extension) return null;
  const fields = sequence(decodeDer(extension.value), 'BasicConstraints');
  let ca = false;
  let pathLength: number | null = null;
  let index = 0;
  if (fields[index]?.isUniversal(TAG.boolean)) ca = boolean(fields[index++]!, 'BasicConstraints cA');
  if (fields[index]?.isUniversal(TAG.integer)) pathLength = smallInteger(fields[index++]!, 'BasicConstraints pathLenConstraint');
  if (index !== fields.length) throw new StructureError('BasicConstraints: unexpected fields');
  return { ca, pathLength };
}

function parseKeyUsage(extension: Extension | undefined): ReadonlySet<KeyUsage> | null {
  if (!extension) return null;
  const element = decodeDer(extension.value);
  expectTag(element, CLASS.universal, TAG.bitString, 'KeyUsage');
  const content = element.content;
  if (content.length === 0 || content[0]! > 7) throw new StructureError('KeyUsage: malformed BIT STRING');
  const bytes = content.subarray(1);
  const usages = new Set<KeyUsage>();
  KEY_USAGE_BITS.forEach((usage, bit) => {
    if (((bytes[bit >> 3] ?? 0) & (0x80 >> (bit & 7))) !== 0) usages.add(usage);
  });
  return usages;
}

function parseExtendedKeyUsage(extension: Extension | undefined): Certificate['extendedKeyUsage'] {
  if (!extension) return null;
  const purposes = sequence(decodeDer(extension.value), 'ExtKeyUsageSyntax').map(item => oid(item, 'KeyPurposeId'));
  if (purposes.length === 0) throw new StructureError('ExtKeyUsageSyntax: empty');
  return { purposes, critical: extension.critical };
}

function parseSubjectKeyIdentifier(extension: Extension | undefined): Uint8Array | null {
  return extension ? octetString(decodeDer(extension.value), 'SubjectKeyIdentifier') : null;
}

// ---------------------------------------------------------------------------------------------
// ContentInfo, SignedData, SignerInfo

export interface Attribute {
  type: string;
  values: DerElement[];
}

export type SignerIdentifier =
  | { kind: 'issuerAndSerialNumber'; issuer: Name; serialNumber: Uint8Array }
  | { kind: 'subjectKeyIdentifier'; keyIdentifier: Uint8Array };

export interface SignerInfo {
  element: DerElement;
  version: number;
  sid: SignerIdentifier;
  digestAlgorithm: AlgorithmIdentifier;
  signedAttributes: Attribute[] | null;
  /** The signed attributes' DER with the [0] IMPLICIT tag replaced by SET OF (0x31): what the signature covers. */
  signedAttributesDer: Uint8Array | null;
  signatureAlgorithm: AlgorithmIdentifier;
  signature: Uint8Array;
  unsignedAttributes: Attribute[] | null;
}

export interface SignedData {
  version: number;
  digestAlgorithms: AlgorithmIdentifier[];
  /** eContentType. */
  contentType: string;
  /** The element inside eContent [0]: an OCTET STRING in CMS, any type in PKCS #7 (Authenticode's SpcIndirectDataContent). */
  content: DerElement | null;
  /**
   * The octets the messageDigest attribute covers: the content octets of that element, without its
   * tag and length (PKCS #7 section 9.3; for an OCTET STRING these are the encapsulated bytes).
   */
  signedContent: Uint8Array | null;
  certificates: Certificate[];
  /** Entries of the certificate set that are not X.509 certificates (attribute certificates and the like), skipped. */
  skippedCertificates: number;
  signerInfos: SignerInfo[];
}

/** contentType and the [0] EXPLICIT content of a ContentInfo. */
export function parseContentInfo(element: DerElement, what = 'ContentInfo'): { contentType: string; content: DerElement } {
  const [type, wrapper, ...rest] = sequence(element, what);
  if (!type || !wrapper || rest.length) throw new StructureError(`${what}: expected contentType and [0] content`);
  expectTag(wrapper, CLASS.context, 0, `${what} content`);
  const [content, ...more] = wrapper.children();
  if (!content || more.length) throw new StructureError(`${what}: [0] must hold exactly one element`);
  return { contentType: oid(type, `${what} contentType`), content };
}

/** The SignedData of a ContentInfo whose contentType is signedData. */
export function parseSignedData(contentInfo: DerElement, what = 'SignedData'): SignedData {
  const { contentType, content } = parseContentInfo(contentInfo, `${what} ContentInfo`);
  if (contentType !== OID.signedData) throw new StructureError(`${what}: expected the ContentInfo type signedData (${OID.signedData}), found ${contentType}`);
  const fields = sequence(content, what);
  const [versionElement, algorithmsElement, encapsulated] = fields;
  if (!versionElement || !algorithmsElement || !encapsulated) throw new StructureError(`${what}: missing version, digestAlgorithms or encapContentInfo`);
  const version = smallInteger(versionElement, `${what} version`);
  const digestAlgorithms = set(algorithmsElement, `${what} digestAlgorithms`).map(item => parseAlgorithm(item, `${what} digestAlgorithm`));
  const [eContentType, eContent, ...encapsulatedRest] = sequence(encapsulated, `${what} encapContentInfo`);
  if (!eContentType || encapsulatedRest.length) throw new StructureError(`${what}: malformed encapContentInfo`);
  let inner: DerElement | null = null;
  if (eContent) {
    expectTag(eContent, CLASS.context, 0, `${what} eContent`);
    const [only, ...more] = eContent.children();
    if (!only || more.length) throw new StructureError(`${what}: eContent [0] must hold exactly one element`);
    inner = only;
  }
  let index = 3;
  const certificates: Certificate[] = [];
  let skippedCertificates = 0;
  if (fields[index]?.isContext(0)) {
    const certificateSet = fields[index++]!;
    if (!certificateSet.constructed) throw new StructureError(`${what}: certificates [0] is not constructed`);
    for (const choice of certificateSet.children()) {
      if (choice.isUniversal(TAG.sequence)) certificates.push(parseCertificate(choice.encoding));
      else if (choice.tagClass === CLASS.context && choice.tagNumber <= 3) skippedCertificates++;
      else throw new StructureError(`${what}: unexpected ${choice.label} in certificates`);
    }
  }
  if (fields[index]?.isContext(1)) index++; // crls: not used, revocation is not checked
  const signerSet = fields[index++];
  if (!signerSet || index !== fields.length) throw new StructureError(`${what}: expected signerInfos as the last field`);
  const signerInfos = set(signerSet, `${what} signerInfos`).map((item, position) => parseSignerInfo(item, `${what} SignerInfo ${position + 1}`));
  return {
    version, digestAlgorithms, contentType: oid(eContentType, `${what} eContentType`), content: inner,
    signedContent: inner ? inner.content : null, certificates, skippedCertificates, signerInfos,
  };
}

function parseAttributes(element: DerElement, what: string): Attribute[] {
  if (!element.constructed) throw new StructureError(`${what}: ${element.label} is not constructed`);
  return element.children().map(item => {
    const [type, values, ...rest] = sequence(item, `${what} attribute`);
    if (!type || !values || rest.length) throw new StructureError(`${what}: an attribute is not a type and a set of values`);
    const id = oid(type, `${what} attribute type`);
    const list = set(values, `${what} attribute ${id} values`);
    if (list.length === 0) throw new StructureError(`${what}: attribute ${id} has no values`);
    return { type: id, values: list };
  });
}

export function parseSignerInfo(element: DerElement, what = 'SignerInfo'): SignerInfo {
  const fields = sequence(element, what);
  const [versionElement, sidElement, digestElement] = fields;
  if (!versionElement || !sidElement || !digestElement) throw new StructureError(`${what}: missing version, sid or digestAlgorithm`);
  const version = smallInteger(versionElement, `${what} version`);
  let sid: SignerIdentifier;
  if (sidElement.isUniversal(TAG.sequence)) {
    const [issuer, serial, ...rest] = sidElement.children();
    if (!issuer || !serial || rest.length) throw new StructureError(`${what}: malformed issuerAndSerialNumber`);
    sid = { kind: 'issuerAndSerialNumber', issuer: parseName(issuer, `${what} issuer`), serialNumber: integer(serial, `${what} serialNumber`) };
    if (version !== 1) throw new StructureError(`${what}: version ${version} with issuerAndSerialNumber (RFC 5652 requires version 1)`);
  } else if (sidElement.isContext(0) && !sidElement.constructed) {
    sid = { kind: 'subjectKeyIdentifier', keyIdentifier: sidElement.content };
    if (version !== 3) throw new StructureError(`${what}: version ${version} with subjectKeyIdentifier (RFC 5652 requires version 3)`);
  } else {
    throw new StructureError(`${what}: unexpected ${sidElement.label} as the signer identifier`);
  }
  const digestAlgorithm = parseAlgorithm(digestElement, `${what} digestAlgorithm`);
  let index = 3;
  let signedAttributes: Attribute[] | null = null;
  let signedAttributesDer: Uint8Array | null = null;
  if (fields[index]?.isContext(0)) {
    const signed = fields[index++]!;
    signedAttributes = parseAttributes(signed, `${what} signedAttrs`);
    // [0] IMPLICIT and SET OF share the one-byte header form, so only the identifier octet changes.
    signedAttributesDer = Uint8Array.from(signed.encoding);
    signedAttributesDer[0] = 0x31;
  }
  const algorithmElement = fields[index++];
  const signatureElement = fields[index++];
  if (!algorithmElement || !signatureElement) throw new StructureError(`${what}: missing signatureAlgorithm or signature`);
  const signatureAlgorithm = parseAlgorithm(algorithmElement, `${what} signatureAlgorithm`);
  const signature = octetString(signatureElement, `${what} signature`);
  let unsignedAttributes: Attribute[] | null = null;
  if (fields[index]?.isContext(1)) unsignedAttributes = parseAttributes(fields[index++]!, `${what} unsignedAttrs`);
  if (index !== fields.length) throw new StructureError(`${what}: unexpected ${fields[index]!.label} after the signature`);
  return { element, version, sid, digestAlgorithm, signedAttributes, signedAttributesDer, signatureAlgorithm, signature, unsignedAttributes };
}

export function attributes(list: readonly Attribute[] | null, type: string): Attribute[] {
  return (list ?? []).filter(attribute => attribute.type === type);
}

/** The value of an attribute that must appear once with one value, or a sentence saying what was found. */
export function singleAttribute(list: readonly Attribute[] | null, type: string, label: string): DerElement | string {
  const found = attributes(list, type);
  if (found.length !== 1) return `expected one ${label} attribute, found ${found.length}`;
  const values = found[0]!.values;
  if (values.length !== 1) return `expected one value in the ${label} attribute, found ${values.length}`;
  return values[0]!;
}

/** The certificate the SignerInfo's sid names; it must be exactly one of `certificates`. */
export function signerCertificate(signer: SignerInfo, certificates: readonly Certificate[]): Certificate {
  const unique = [...new Map(certificates.map(certificate => [certificate.sha256, certificate])).values()];
  const sid = signer.sid;
  const matches = sid.kind === 'issuerAndSerialNumber'
    ? unique.filter(certificate => bytesEqual(certificate.issuer.der, sid.issuer.der) && bytesEqual(certificate.serialNumber, sid.serialNumber))
    : unique.filter(certificate => certificate.subjectKeyIdentifier !== null && bytesEqual(certificate.subjectKeyIdentifier, sid.keyIdentifier));
  const named = sid.kind === 'issuerAndSerialNumber' ? `issuer "${sid.issuer.text}" and serial ${hex(sid.serialNumber).toUpperCase()}` : `subject key identifier ${hex(sid.keyIdentifier)}`;
  if (matches.length === 0) throw new StructureError(`the signer is named by ${named}, but no embedded certificate has it`);
  if (matches.length > 1) throw new StructureError(`the signer is named by ${named}, which ${matches.length} different embedded certificates carry`);
  return matches[0]!;
}

// ---------------------------------------------------------------------------------------------
// Signer verification

export interface SignerVerification {
  /** Sentences saying what was expected and what was found; empty when the signer verifies. */
  problems: string[];
  digestAlgorithm: HashName | null;
  /** "RSA PKCS #1 v1.5 with sha256" and the like. */
  signatureScheme: string | null;
  /** Value of the messageDigest attribute, hex. */
  messageDigest: string | null;
}

export interface SignerExpectations {
  /** The octets the messageDigest attribute must hash to. */
  content: Uint8Array;
  /** Required value of the contentType attribute; "countersignature" means absent or id-data (PKCS #9 9.2). */
  contentType: string | 'countersignature';
  /** OIDs of the enclosing SignedData's digestAlgorithms, which must list the signer's; null for a countersignature. */
  digestAlgorithms: readonly string[] | null;
}

/**
 * Checks a SignerInfo's signed attributes and signature against its certificate: contentType,
 * messageDigest over `content`, and the signature over the attributes' SET OF encoding.
 */
export function verifySigner(signer: SignerInfo, certificate: Certificate, expected: SignerExpectations): SignerVerification {
  const problems: string[] = [];
  const hash = hashAlgorithm(signer.digestAlgorithm, 'SignerInfo digestAlgorithm');
  const digestAlgorithm = isHashName(hash) ? hash : null;
  if (!isHashName(hash)) problems.push(hash);
  if (expected.digestAlgorithms && !expected.digestAlgorithms.includes(signer.digestAlgorithm.oid)) {
    problems.push(`SignedData digestAlgorithms (${expected.digestAlgorithms.join(', ') || 'none'}) do not list the signer's ${signer.digestAlgorithm.oid}`);
  }
  if (!signer.signedAttributes || !signer.signedAttributesDer) {
    problems.push('expected signed attributes, found none');
    return { problems, digestAlgorithm, signatureScheme: null, messageDigest: null };
  }
  const contentType = attributes(signer.signedAttributes, OID.contentType);
  if (expected.contentType === 'countersignature') {
    if (contentType.length > 1) problems.push(`expected at most one contentType attribute, found ${contentType.length}`);
    for (const attribute of contentType) {
      const value = attribute.values.length === 1 ? oid(attribute.values[0]!, 'contentType') : null;
      if (value !== OID.data) problems.push(`contentType attribute of a countersignature: expected none or id-data, found ${value ?? `${attribute.values.length} values`}`);
    }
  } else {
    const value = singleAttribute(signer.signedAttributes, OID.contentType, 'contentType');
    if (typeof value === 'string') problems.push(value);
    else {
      const found = oid(value, 'contentType attribute');
      if (found !== expected.contentType) problems.push(`contentType attribute: expected ${expected.contentType}, found ${found}`);
    }
  }
  let messageDigest: string | null = null;
  const digestValue = singleAttribute(signer.signedAttributes, OID.messageDigest, 'messageDigest');
  if (typeof digestValue === 'string') problems.push(digestValue);
  else {
    const claimed = octetString(digestValue, 'messageDigest attribute');
    messageDigest = hex(claimed);
    if (digestAlgorithm) {
      const actual = hex(digest(digestAlgorithm, expected.content));
      if (actual !== messageDigest) problems.push(`messageDigest attribute: expected the ${digestAlgorithm} of the signed content ${actual}, found ${messageDigest}`);
    }
  }
  let signatureScheme: string | null = null;
  if (digestAlgorithm) {
    const result = verifySignatureValue(signer.signatureAlgorithm, digestAlgorithm, certificate.x509.publicKey, signer.signedAttributesDer, signer.signature);
    signatureScheme = result.scheme;
    if (result.problem) problems.push(result.problem);
  }
  return { problems, digestAlgorithm, signatureScheme, messageDigest };
}

/** Verifies `signature` over `data` with the scheme `algorithm` names; returns a problem sentence or null. */
export function verifySignatureValue(algorithm: AlgorithmIdentifier, hash: HashName, key: KeyObject, data: Uint8Array, signature: Uint8Array): { scheme: string | null; problem: string | null } {
  const keyType = key.asymmetricKeyType;
  let scheme: string;
  let options: Parameters<typeof cryptoVerify>[2];
  if (algorithm.oid in RSA_PKCS1) {
    const named = RSA_PKCS1[algorithm.oid];
    if (named && named !== hash) return { scheme: null, problem: `signatureAlgorithm ${algorithm.oid} uses ${named}, but the digestAlgorithm is ${hash}` };
    if (!hasNoParameters(algorithm)) return { scheme: null, problem: `signatureAlgorithm ${algorithm.oid} has unexpected parameters` };
    if (keyType !== 'rsa') return { scheme: null, problem: `signatureAlgorithm is RSA PKCS #1 v1.5, but the signer's key is ${keyType ?? 'unknown'}` };
    scheme = `RSA PKCS #1 v1.5 with ${hash}`;
    options = key;
  } else if (algorithm.oid === OID.rsassaPss) {
    const parameters = pssParameters(algorithm);
    if (typeof parameters === 'string') return { scheme: null, problem: parameters };
    if (parameters.hash !== hash) return { scheme: null, problem: `RSA-PSS parameters use ${parameters.hash}, but the digestAlgorithm is ${hash}` };
    if (keyType !== 'rsa' && keyType !== 'rsa-pss') return { scheme: null, problem: `signatureAlgorithm is RSA-PSS, but the signer's key is ${keyType ?? 'unknown'}` };
    scheme = `RSA-PSS with ${hash}, salt ${parameters.saltLength}`;
    options = { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: parameters.saltLength };
  } else if (algorithm.oid in ECDSA) {
    const named = ECDSA[algorithm.oid];
    if (named && named !== hash) return { scheme: null, problem: `signatureAlgorithm ${algorithm.oid} uses ${named}, but the digestAlgorithm is ${hash}` };
    if (algorithm.parameters !== null && named !== null) return { scheme: null, problem: `signatureAlgorithm ${algorithm.oid} has unexpected parameters` };
    if (keyType !== 'ec') return { scheme: null, problem: `signatureAlgorithm is ECDSA, but the signer's key is ${keyType ?? 'unknown'}` };
    scheme = `ECDSA with ${hash}`;
    options = { key, dsaEncoding: 'der' };
  } else {
    return { scheme: null, problem: `signatureAlgorithm: expected RSA PKCS #1 v1.5, RSA-PSS or ECDSA, found ${algorithm.oid}` };
  }
  let valid: boolean;
  try {
    valid = cryptoVerify(hash, data, options, signature);
  } catch (error) {
    return { scheme, problem: `the signature could not be checked (${scheme}): ${error instanceof Error ? error.message : String(error)}` };
  }
  return { scheme, problem: valid ? null : `the signature does not verify with the signer certificate's key (${scheme})` };
}

/** RSASSA-PSS-params (RFC 4055); the SHA-1 defaults are refused like any SHA-1 signature. */
function pssParameters(algorithm: AlgorithmIdentifier): { hash: HashName; saltLength: number } | string {
  if (!algorithm.parameters) return 'RSA-PSS signatureAlgorithm without parameters';
  let hash: string = 'sha1';
  let mgfHash: string = 'sha1';
  let saltLength = 20;
  for (const field of sequence(algorithm.parameters, 'RSASSA-PSS-params')) {
    const [inner, ...more] = field.constructed ? field.children() : [];
    if (!inner || more.length) return 'RSASSA-PSS-params: malformed field';
    if (field.isContext(0)) hash = hashAlgorithm(parseAlgorithm(inner, 'RSA-PSS hashAlgorithm'), 'RSA-PSS hashAlgorithm');
    else if (field.isContext(1)) {
      const mgf = parseAlgorithm(inner, 'RSA-PSS maskGenAlgorithm');
      if (mgf.oid !== OID.mgf1 || !mgf.parameters) return `RSA-PSS maskGenAlgorithm: expected MGF1, found ${mgf.oid}`;
      mgfHash = hashAlgorithm(parseAlgorithm(mgf.parameters, 'MGF1 hash'), 'MGF1 hash');
    } else if (field.isContext(2)) saltLength = smallInteger(inner, 'RSA-PSS saltLength');
    else if (field.isContext(3)) {
      if (smallInteger(inner, 'RSA-PSS trailerField') !== 1) return 'RSA-PSS trailerField: expected 1';
    } else return `RSASSA-PSS-params: unexpected ${field.label}`;
  }
  if (!isHashName(hash)) return hash;
  if (!isHashName(mgfHash)) return mgfHash;
  if (hash !== mgfHash) return `RSA-PSS: the hash ${hash} differs from the MGF1 hash ${mgfHash}`;
  if (!ACCEPTED_HASHES.has(hash)) return `RSA-PSS: ${hash.toUpperCase()} is not accepted (expected SHA-256, SHA-384 or SHA-512)`;
  return { hash, saltLength };
}

// ---------------------------------------------------------------------------------------------
// Chain building

export interface ChainRequest {
  /** Certificates the chain may pass through: those embedded in the signature. */
  pool: readonly Certificate[];
  /** Pinned roots; a chain ends at the first certificate that is one of them or that one of them signed. */
  roots: readonly Certificate[];
  /** When every certificate in the chain must be valid: the signing time. */
  at: Date;
  /** Extended key usage the leaf must carry (and any intermediate that restricts its usages). */
  purpose: string;
}

export type ChainResult =
  | { ok: true; chain: Certificate[] }
  | { ok: false; problem: string; chain: Certificate[] };

/** Longest chain followed, root included. */
const MAX_CHAIN = 8;

const names = (chain: readonly Certificate[]) => chain.map(certificate => certificate.subject.text).join(' <- ');

function signedBy(child: Certificate, issuer: Certificate): boolean {
  if (!bytesEqual(child.issuer.der, issuer.subject.der)) return false;
  try {
    return child.x509.verify(issuer.x509.publicKey);
  } catch {
    return false;
  }
}

/**
 * Every path from `leaf` to a pinned root through `pool`, shortest first. A path stops at a
 * certificate that is a pinned root (same SHA-256) or that a pinned root's key signed, so embedded
 * cross-signed copies of a root are never followed past it.
 */
function candidatePaths(leaf: Certificate, pool: readonly Certificate[], roots: readonly Certificate[]): Certificate[][] {
  const found: Certificate[][] = [];
  const visit = (chain: Certificate[]) => {
    if (found.length >= 16) return;
    const current = chain[chain.length - 1]!;
    if (roots.some(root => root.sha256 === current.sha256)) { found.push(chain); return; }
    const root = roots.find(candidate => signedBy(current, candidate));
    if (root) { found.push([...chain, root]); return; }
    if (chain.length >= MAX_CHAIN - 1) return;
    for (const candidate of pool) {
      if (chain.some(link => link.sha256 === candidate.sha256)) continue;
      if (signedBy(current, candidate)) visit([...chain, candidate]);
    }
  };
  visit([leaf]);
  return found.sort((a, b) => a.length - b.length);
}

const iso = (date: Date) => date.toISOString().replace('.000Z', 'Z');

/** The first problem of one path, or null when every certificate in it is acceptable at `at`. */
function pathProblem(chain: readonly Certificate[], request: ChainRequest): string | null {
  const rootIndex = chain.length - 1;
  for (const [index, certificate] of chain.entries()) {
    const name = `"${certificate.subject.text}"`;
    if (request.at < certificate.notBefore || request.at > certificate.notAfter) {
      return `${name} is valid ${iso(certificate.notBefore)} to ${iso(certificate.notAfter)}, not at the signing time ${iso(request.at)}`;
    }
    if (index === rootIndex) continue; // the pinned root is trusted as it is
    if (WEAK_CERTIFICATE_SIGNATURES.has(certificate.signatureAlgorithm)) return `${name} is signed with ${certificate.signatureAlgorithm}, an MD5 or SHA-1 based algorithm`;
    const critical = certificate.extensions.find(extension => extension.critical && !UNDERSTOOD_EXTENSIONS.has(extension.oid));
    if (critical) return `${name} has the critical extension ${critical.oid}, which this verifier does not process`;
    const usages = certificate.extendedKeyUsage?.purposes ?? null;
    if (index === 0) {
      if (certificate.basicConstraints?.ca) return `${name} signs as a leaf but is a CA certificate`;
      if (certificate.keyUsage && !certificate.keyUsage.has('digitalSignature')) return `${name}: key usage ${[...certificate.keyUsage].join(', ')} lacks digitalSignature`;
      if (!usages || !usages.includes(request.purpose)) return `${name}: expected the extended key usage ${request.purpose}, found ${usages?.join(', ') ?? 'none'}`;
      // RFC 3161 2.3 also asks for the extension to be critical. Microsoft's Time-Stamp Service
      // certificates of 2022 (in the Store's 1.192.647.0 x86 package) leave it non-critical and Windows
      // accepts them; this check reads and enforces the usage itself, so only its content is required.
      if (request.purpose === OID.timeStamping && usages.length !== 1) {
        return `${name}: RFC 3161 requires id-kp-timeStamping as the only extended key usage; found ${usages.join(', ')}`;
      }
    } else if (usages && !usages.includes(request.purpose) && !usages.includes(OID.anyExtendedKeyUsage)) {
      return `${name} restricts its extended key usage to ${usages.join(', ')}, without ${request.purpose}`;
    }
    const policies = certificate.applicationPolicies;
    if (policies && !policies.includes(request.purpose) && !policies.includes(OID.anyExtendedKeyUsage)) {
      return `${name} restricts its application policies to ${policies.join(', ')}, without ${request.purpose}`;
    }
  }
  for (let index = 1; index < chain.length; index++) {
    const issuer = chain[index]!;
    const name = `"${issuer.subject.text}"`;
    if (!issuer.basicConstraints?.ca) return `${name} issues "${chain[index - 1]!.subject.text}" but is not a CA certificate (basicConstraints cA)`;
    if (issuer.keyUsage && !issuer.keyUsage.has('keyCertSign')) return `${name} issues certificates without the keyCertSign key usage`;
    const below = index - 1; // intermediate CA certificates between this issuer and the leaf
    if (issuer.basicConstraints.pathLength !== null && below > issuer.basicConstraints.pathLength) {
      return `${name} allows ${issuer.basicConstraints.pathLength} intermediate CA certificate(s) below it, the chain has ${below}`;
    }
  }
  return null;
}

/** Builds and checks the chain from `leaf` to one of the pinned roots. */
export function buildChain(leaf: Certificate, request: ChainRequest): ChainResult {
  if (request.roots.length === 0) return { ok: false, problem: 'no pinned root certificate to chain to', chain: [leaf] };
  const paths = candidatePaths(leaf, request.pool, request.roots);
  if (paths.length === 0) {
    return { ok: false, problem: `"${leaf.subject.text}" (issued by "${leaf.issuer.text}") does not chain to the pinned root(s) ${request.roots.map(root => `"${root.subject.text}"`).join(', ')}`, chain: [leaf] };
  }
  let first: { problem: string; chain: Certificate[] } | null = null;
  for (const chain of paths) {
    const problem = pathProblem(chain, request);
    if (!problem) return { ok: true, chain };
    first ??= { problem: `${problem} (chain ${names(chain)})`, chain };
  }
  return { ok: false, ...first! };
}

// ---------------------------------------------------------------------------------------------
// Timestamps

export interface TimestampVerification {
  kind: 'rfc3161' | 'pkcs9-countersignature';
  /** Problems found; empty when the timestamp verifies. */
  problems: string[];
  /** TSTInfo genTime, or the countersignature's signingTime. */
  time: Date | null;
  signer: Certificate | null;
  chain: Certificate[];
  digestAlgorithm: HashName | null;
  policy: string | null;
  serialNumber: string | null;
}

/** Tolerated clock difference before a timestamp counts as being in the future. */
const FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Finds and verifies the timestamp on `signer` (an RFC 3161 token or a PKCS #9 countersignature).
 * Returns null when the signer carries none; more than one is reported as a problem.
 */
export function verifyTimestamp(signer: SignerInfo, outer: SignedData, roots: readonly Certificate[], now: Date): TimestampVerification | null {
  const tokens = attributes(signer.unsignedAttributes, OID.rfc3161Timestamp);
  const countersignatures = attributes(signer.unsignedAttributes, OID.counterSignature);
  const values = [...tokens, ...countersignatures].reduce((count, attribute) => count + attribute.values.length, 0);
  if (values === 0) return null;
  const kind = tokens.length ? 'rfc3161' : 'pkcs9-countersignature';
  const empty: TimestampVerification = { kind, problems: [], time: null, signer: null, chain: [], digestAlgorithm: null, policy: null, serialNumber: null };
  if (values > 1) return { ...empty, problems: [`expected one timestamp, found ${values} (${tokens.length} RFC 3161 attribute(s), ${countersignatures.length} countersignature attribute(s))`] };
  try {
    return kind === 'rfc3161'
      ? verifyRfc3161(tokens[0]!.values[0]!, signer, outer, roots, now)
      : verifyCountersignature(countersignatures[0]!.values[0]!, signer, outer, roots, now);
  } catch (error) {
    if (error instanceof DerError || error instanceof StructureError) return { ...empty, problems: [`the timestamp could not be read: ${error.message}`] };
    throw error;
  }
}

function verifyRfc3161(value: DerElement, outerSigner: SignerInfo, outer: SignedData, roots: readonly Certificate[], now: Date): TimestampVerification {
  const result: TimestampVerification = { kind: 'rfc3161', problems: [], time: null, signer: null, chain: [], digestAlgorithm: null, policy: null, serialNumber: null };
  const token = parseSignedData(value, 'timestamp token');
  if (token.contentType !== OID.tstInfo) throw new StructureError(`timestamp token: expected the eContentType id-ct-TSTInfo (${OID.tstInfo}), found ${token.contentType}`);
  if (!token.content || !token.content.isUniversal(TAG.octetString) || !token.signedContent) throw new StructureError('timestamp token: eContent is not an OCTET STRING holding the TSTInfo');
  if (token.signerInfos.length !== 1) throw new StructureError(`timestamp token: expected one SignerInfo, found ${token.signerInfos.length}`);
  const tsaSigner = token.signerInfos[0]!;
  const pool = [...token.certificates, ...outer.certificates];
  const certificate = signerCertificate(tsaSigner, pool);
  result.signer = certificate;
  const signed = verifySigner(tsaSigner, certificate, { content: token.signedContent, contentType: OID.tstInfo, digestAlgorithms: token.digestAlgorithms.map(item => item.oid) });
  result.digestAlgorithm = signed.digestAlgorithm;
  result.problems.push(...signed.problems.map(problem => `timestamp signer: ${problem}`));
  const binding = signingCertificateProblem(tsaSigner, certificate);
  if (binding) result.problems.push(`timestamp signer: ${binding}`);

  const info = sequence(decodeDer(token.signedContent), 'TSTInfo');
  const [versionElement, policyElement, imprintElement, serialElement, genTimeElement] = info;
  if (!versionElement || !policyElement || !imprintElement || !serialElement || !genTimeElement) throw new StructureError('TSTInfo: missing version, policy, messageImprint, serialNumber or genTime');
  const version = smallInteger(versionElement, 'TSTInfo version');
  if (version !== 1) result.problems.push(`TSTInfo version: expected 1, found ${version}`);
  result.policy = oid(policyElement, 'TSTInfo policy');
  result.serialNumber = hex(integer(serialElement, 'TSTInfo serialNumber')).toUpperCase();
  expectTag(genTimeElement, CLASS.universal, TAG.generalizedTime, 'TSTInfo genTime');
  result.time = time(genTimeElement, 'TSTInfo genTime');
  const [imprintAlgorithm, hashedMessage, ...imprintRest] = sequence(imprintElement, 'MessageImprint');
  if (!imprintAlgorithm || !hashedMessage || imprintRest.length) throw new StructureError('MessageImprint: expected hashAlgorithm and hashedMessage');
  const imprintHash = hashAlgorithm(parseAlgorithm(imprintAlgorithm, 'MessageImprint hashAlgorithm'), 'MessageImprint hashAlgorithm');
  if (!isHashName(imprintHash)) result.problems.push(imprintHash);
  else {
    const expected = hex(digest(imprintHash, outerSigner.signature));
    const found = hex(octetString(hashedMessage, 'MessageImprint hashedMessage'));
    if (expected !== found) result.problems.push(`TSTInfo messageImprint: expected the ${imprintHash} of the signature value ${expected}, found ${found}`);
  }
  finishTimestamp(result, certificate, pool, roots, now);
  return result;
}

function verifyCountersignature(value: DerElement, outerSigner: SignerInfo, outer: SignedData, roots: readonly Certificate[], now: Date): TimestampVerification {
  const result: TimestampVerification = { kind: 'pkcs9-countersignature', problems: [], time: null, signer: null, chain: [], digestAlgorithm: null, policy: null, serialNumber: null };
  const countersigner = parseSignerInfo(value, 'countersignature');
  const certificate = signerCertificate(countersigner, outer.certificates);
  result.signer = certificate;
  const signed = verifySigner(countersigner, certificate, { content: outerSigner.signature, contentType: 'countersignature', digestAlgorithms: null });
  result.digestAlgorithm = signed.digestAlgorithm;
  result.problems.push(...signed.problems.map(problem => `countersignature: ${problem}`));
  const signingTime = singleAttribute(countersigner.signedAttributes, OID.signingTime, 'signingTime');
  if (typeof signingTime === 'string') throw new StructureError(`countersignature: ${signingTime}`);
  result.time = time(signingTime, 'countersignature signingTime');
  finishTimestamp(result, certificate, outer.certificates, roots, now);
  return result;
}

function finishTimestamp(result: TimestampVerification, certificate: Certificate, pool: readonly Certificate[], roots: readonly Certificate[], now: Date): void {
  if (!result.time) return;
  if (result.time.getTime() > now.getTime() + FUTURE_SKEW_MS) result.problems.push(`the timestamp ${iso(result.time)} is later than the verification time ${iso(now)}`);
  const chain = buildChain(certificate, { pool, roots, at: result.time, purpose: OID.timeStamping });
  result.chain = chain.chain;
  if (!chain.ok) result.problems.push(`timestamp chain: ${chain.problem}`);
}

/**
 * The ESS signing-certificate binding (RFC 2634 / RFC 5035) RFC 3161 requires: the first ESSCertID
 * (v2, else v1) must hash to the timestamp signer's certificate.
 */
function signingCertificateProblem(signer: SignerInfo, certificate: Certificate): string | null {
  const v2 = attributes(signer.signedAttributes, OID.signingCertificateV2);
  const v1 = attributes(signer.signedAttributes, OID.signingCertificate);
  const attribute = v2[0] ?? v1[0];
  if (!attribute) return 'expected an ESS signingCertificate or signingCertificateV2 attribute, found neither';
  if (v2.length > 1 || v1.length > 1 || attribute.values.length !== 1) return 'expected one value in the ESS signing-certificate attribute';
  const [certs] = sequence(attribute.values[0]!, 'SigningCertificate');
  if (!certs) throw new StructureError('SigningCertificate: no certs');
  const [first] = sequence(certs, 'SigningCertificate certs');
  if (!first) throw new StructureError('SigningCertificate: empty certs');
  const fields = sequence(first, 'ESSCertID');
  let hash: HashName = 'sha1';
  let index = 0;
  if (attribute === v2[0] && fields[0]?.isUniversal(TAG.sequence)) {
    const named = hashAlgorithm(parseAlgorithm(fields[0], 'ESSCertIDv2 hashAlgorithm'), 'ESSCertIDv2 hashAlgorithm');
    if (!isHashName(named)) return named;
    hash = named;
    index = 1;
  } else if (attribute === v2[0]) {
    hash = 'sha256'; // ESSCertIDv2's default
  }
  const certHash = fields[index];
  if (!certHash) throw new StructureError('ESSCertID: no certHash');
  const expected = hex(digest(hash, certificate.der));
  const found = hex(octetString(certHash, 'ESSCertID certHash'));
  return expected === found ? null : `ESS signing certificate: expected the ${hash} of "${certificate.subject.text}" ${expected}, found ${found}`;
}

// ---------------------------------------------------------------------------------------------
// Authenticode content

export interface SpcIndirectDataContent {
  /** SpcAttributeTypeAndOptionalValue.type: SpcPeImageData for PE files, SpcSipInfo for packages. */
  dataType: string;
  dataValue: DerElement | null;
  digestAlgorithm: AlgorithmIdentifier;
  digest: Uint8Array;
}

/** SpcIndirectDataContent ::= SEQUENCE { data SpcAttributeTypeAndOptionalValue, messageDigest DigestInfo }. */
export function parseSpcIndirectDataContent(element: DerElement): SpcIndirectDataContent {
  const [data, digestInfo, ...rest] = sequence(element, 'SpcIndirectDataContent');
  if (!data || !digestInfo || rest.length) throw new StructureError('SpcIndirectDataContent: expected data and messageDigest');
  const [type, value, ...more] = sequence(data, 'SpcAttributeTypeAndOptionalValue');
  if (!type || more.length) throw new StructureError('SpcAttributeTypeAndOptionalValue: malformed');
  const [algorithm, digestValue, ...digestRest] = sequence(digestInfo, 'DigestInfo');
  if (!algorithm || !digestValue || digestRest.length) throw new StructureError('DigestInfo: expected digestAlgorithm and digest');
  return {
    dataType: oid(type, 'SpcAttributeTypeAndOptionalValue type'),
    dataValue: value ?? null,
    digestAlgorithm: parseAlgorithm(algorithm, 'DigestInfo digestAlgorithm'),
    digest: octetString(digestValue, 'DigestInfo digest'),
  };
}
