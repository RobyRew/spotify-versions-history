/**
 * OpenPGP v4 read in-process (RFC 4880, RFC 9580): ASCII armor with its CRC-24, packets in the old and
 * new formats, v4 public keys (RSA, Ed25519 as EdDSA 22 or as algorithm 27), v4 signatures with their
 * subpackets, transferable public keys with their self-signatures, and signature verification with
 * node:crypto.
 *
 * Every reader throws OpenPgpError for input it does not fully understand, so a caller turns any
 * surprise into a failed check. Nothing here decides which key is trusted: callers pin keys by
 * fingerprint and pass only those.
 */
import { createHash, createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * - malformed: the bytes do not follow the format;
 * - unsupported: a valid construct this reader does not evaluate (an algorithm, a version, a critical subpacket);
 * - invalid: well-formed, but the signature or key does not hold.
 */
export type OpenPgpErrorKind = 'malformed' | 'unsupported' | 'invalid';

export class OpenPgpError extends Error {
  readonly kind: OpenPgpErrorKind;
  constructor(kind: OpenPgpErrorKind, message: string) {
    super(message);
    this.name = 'OpenPgpError';
    this.kind = kind;
  }
}

const malformed = (message: string) => new OpenPgpError('malformed', message);
const unsupported = (message: string) => new OpenPgpError('unsupported', message);
const invalid = (message: string) => new OpenPgpError('invalid', message);

const hex = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
const iso = (date: Date) => date.toISOString();
const concat = (parts: readonly Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));

function u16(bytes: Uint8Array, at: number): number {
  if (at + 2 > bytes.length) throw malformed(`two-byte field at offset ${at} lies past the end (${bytes.length} bytes)`);
  return (bytes[at]! << 8) | bytes[at + 1]!;
}

function u32(bytes: Uint8Array, at: number): number {
  if (at + 4 > bytes.length) throw malformed(`four-byte field at offset ${at} lies past the end (${bytes.length} bytes)`);
  return ((bytes[at]! << 24) >>> 0) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
}

const be32 = (value: number) => Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);

const PUBLIC_KEY_ALGORITHMS: Readonly<Record<number, string>> = {
  1: 'RSA', 2: 'RSA encrypt-only', 3: 'RSA sign-only', 16: 'ElGamal', 17: 'DSA', 18: 'ECDH', 19: 'ECDSA',
  20: 'ElGamal sign-or-encrypt', 21: 'Diffie-Hellman', 22: 'EdDSA', 25: 'X25519', 26: 'X448', 27: 'Ed25519', 28: 'Ed448',
};

/** Hash algorithm ids with the names the cleartext "Hash:" header uses; `node` is set for the ones verified here. */
const HASH_ALGORITHMS: Readonly<Record<number, { name: string; node?: string }>> = {
  1: { name: 'MD5' }, 2: { name: 'SHA1' }, 3: { name: 'RIPEMD160' },
  8: { name: 'SHA256', node: 'sha256' }, 9: { name: 'SHA384', node: 'sha384' }, 10: { name: 'SHA512', node: 'sha512' }, 11: { name: 'SHA224', node: 'sha224' },
  12: { name: 'SHA3-256' }, 14: { name: 'SHA3-512' },
};

export function publicKeyAlgorithmName(id: number): string {
  return `${PUBLIC_KEY_ALGORITHMS[id] ?? 'unknown'} (algorithm ${id})`;
}

/** The name the cleartext "Hash:" armor header uses for a hash algorithm id, e.g. "SHA256". */
export function hashAlgorithmName(id: number): string {
  return HASH_ALGORITHMS[id]?.name ?? `unknown hash (algorithm ${id})`;
}

// ---------------------------------------------------------------------------------------------
// ASCII armor

/** CRC-24 of RFC 4880 section 6.1 (initial value 0xB704CE, polynomial 0x1864CFB). */
export function crc24(data: Uint8Array): number {
  let crc = 0xb704ce;
  for (const byte of data) {
    crc ^= byte << 16;
    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }
  return crc & 0xffffff;
}

export interface Armor {
  /** What follows "BEGIN PGP ": "SIGNATURE", "PUBLIC KEY BLOCK", "MESSAGE". */
  label: string;
  headers: [string, string][];
  data: Uint8Array;
  /** Whether the armor carried a CRC-24 line (RFC 9580 makes it optional; when present it must match). */
  checksum: boolean;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Strict base64: the standard alphabet, padding only at the end, no stray characters. */
export function decodeBase64Strict(text: string, what: string): Uint8Array {
  if (!BASE64.test(text)) throw malformed(`${what} is not valid base64`);
  return new Uint8Array(Buffer.from(text, 'base64'));
}

/**
 * Decodes one armored block. Leading blank lines are skipped; after the END line only blank lines
 * may follow. Trailing spaces and tabs on armor lines are ignored.
 */
export function dearmor(text: string): Armor {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/[ \t\r]+$/, ''));
  let at = 0;
  while (at < lines.length && lines[at] === '') at++;
  const begin = /^-----BEGIN PGP ([A-Z0-9 ,/]+)-----$/.exec(lines[at] ?? '');
  if (!begin) throw malformed('no "-----BEGIN PGP ...-----" armor line');
  const label = begin[1]!;
  at++;
  const headers: [string, string][] = [];
  for (; at < lines.length && lines[at] !== ''; at++) {
    const header = /^([^:\s]+): ?(.*)$/.exec(lines[at]!);
    if (!header) throw malformed(`armor header line ${JSON.stringify(lines[at])} is not "Key: Value"`);
    headers.push([header[1]!, header[2]!]);
  }
  if (at >= lines.length) throw malformed('the armor ends before the blank line that precedes its data');
  at++;
  const data: string[] = [];
  let checksum: string | null = null;
  for (; at < lines.length; at++) {
    const line = lines[at]!;
    if (line.startsWith('-----')) break;
    if (checksum !== null) throw malformed('armor data continues after the checksum line');
    if (line.startsWith('=')) checksum = line.slice(1);
    else data.push(line);
  }
  if (lines[at] !== `-----END PGP ${label}-----`) throw malformed(`no "-----END PGP ${label}-----" line closes the armor`);
  for (at++; at < lines.length; at++) {
    if (lines[at] !== '') throw malformed(`text after the armor's END line: ${JSON.stringify(lines[at]!.slice(0, 40))}`);
  }
  const bytes = decodeBase64Strict(data.join(''), 'the armor data');
  if (checksum !== null) {
    const stated = decodeBase64Strict(checksum, 'the armor checksum');
    if (stated.length !== 3) throw malformed(`the armor checksum holds ${stated.length} bytes, not 3`);
    const statedCrc = (stated[0]! << 16) | (stated[1]! << 8) | stated[2]!;
    const actual = crc24(bytes);
    if (statedCrc !== actual) {
      throw malformed(`armor CRC-24 mismatch: the armor states ${statedCrc.toString(16).padStart(6, '0')}, the data has ${actual.toString(16).padStart(6, '0')}`);
    }
  }
  return { label, headers, data: bytes, checksum: checksum !== null };
}

// ---------------------------------------------------------------------------------------------
// Packets

export interface Packet {
  tag: number;
  body: Uint8Array;
  /** Offset of the packet header in the data it was read from. */
  offset: number;
}

/**
 * Splits data into packets. Partial body lengths (new format) and indeterminate lengths (old format)
 * are rejected: keys and signatures never use them, only streamed data packets do.
 */
export function readPackets(data: Uint8Array): Packet[] {
  const packets: Packet[] = [];
  let at = 0;
  while (at < data.length) {
    const offset = at;
    const first = data[at++]!;
    if ((first & 0x80) === 0) throw malformed(`byte 0x${first.toString(16).padStart(2, '0')} at offset ${offset} is not a packet header`);
    let tag: number;
    let length: number;
    if (first & 0x40) {
      tag = first & 0x3f;
      if (at >= data.length) throw malformed(`packet header at offset ${offset} is cut short`);
      const octet = data[at++]!;
      if (octet < 192) length = octet;
      else if (octet < 224) {
        if (at >= data.length) throw malformed(`packet header at offset ${offset} is cut short`);
        length = ((octet - 192) << 8) + data[at++]! + 192;
      } else if (octet === 255) {
        length = u32(data, at);
        at += 4;
      } else {
        throw unsupported(`packet at offset ${offset} uses a partial body length, which keys and signatures do not use`);
      }
    } else {
      tag = (first >> 2) & 0x0f;
      const lengthType = first & 0x03;
      if (lengthType === 3) throw unsupported(`old-format packet at offset ${offset} has an indeterminate length`);
      const size = [1, 2, 4][lengthType]!;
      if (at + size > data.length) throw malformed(`packet header at offset ${offset} is cut short`);
      length = 0;
      for (let i = 0; i < size; i++) length = length * 256 + data[at + i]!;
      at += size;
    }
    if (tag === 0) throw malformed(`packet at offset ${offset} has the reserved tag 0`);
    if (length > data.length - at) throw malformed(`packet at offset ${offset} declares ${length} bytes, ${data.length - at} remain`);
    packets.push({ tag, body: data.subarray(at, at + length), offset });
    at += length;
  }
  return packets;
}

/** A packet with a new-format header, encoded the way Go's x/crypto/openpgp serializeHeader writes it. */
export function encodePacket(tag: number, body: Uint8Array): Uint8Array {
  if (tag < 1 || tag > 63) throw new RangeError(`packet tag ${tag}`);
  const length = body.length;
  let header: Uint8Array;
  if (length < 192) header = Uint8Array.of(0xc0 | tag, length);
  else if (length < 8384) header = Uint8Array.of(0xc0 | tag, 192 + ((length - 192) >> 8), (length - 192) & 0xff);
  else header = concat([Uint8Array.of(0xc0 | tag, 255), be32(length)]);
  return concat([header, body]);
}

function readMpi(bytes: Uint8Array, at: number): [value: Uint8Array, next: number] {
  const bits = u16(bytes, at);
  const size = (bits + 7) >> 3;
  if (at + 2 + size > bytes.length) throw malformed(`MPI of ${bits} bits at offset ${at} lies past the end`);
  return [bytes.subarray(at + 2, at + 2 + size), at + 2 + size];
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  return bytes.subarray(start);
}

function bitLength(bytes: Uint8Array): number {
  const value = stripLeadingZeros(bytes);
  return value.length === 0 ? 0 : (value.length - 1) * 8 + (32 - Math.clz32(value[0]!));
}

/** A multiprecision integer: two-byte bit count, then the value's big-endian bytes without leading zeros. */
export function encodeMpi(value: Uint8Array): Uint8Array {
  const bytes = stripLeadingZeros(value);
  const bits = bitLength(bytes);
  return concat([Uint8Array.of(bits >> 8, bits & 0xff), bytes]);
}

function leftPad(bytes: Uint8Array, size: number): Uint8Array {
  if (bytes.length >= size) return bytes;
  const out = new Uint8Array(size);
  out.set(bytes, size - bytes.length);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Public keys

export interface PublicKey {
  version: 4;
  created: Date;
  algorithm: number;
  /** The packet body, as the fingerprint and key signatures hash it. */
  body: Uint8Array;
  /** v4 fingerprint: SHA-1 over 0x99, the two-byte body length and the body; 40 upper-case hex digits. */
  fingerprint: string;
  /** The low 64 bits of the fingerprint, 16 upper-case hex digits. */
  keyId: string;
}

/** Reads a public-key or public-subkey packet body. The key material is read only when a signature needs it. */
export function parsePublicKey(body: Uint8Array): PublicKey {
  if (body.length < 6) throw malformed(`public key packet of ${body.length} bytes`);
  if (body[0] !== 4) throw unsupported(`public key version ${body[0]} (only version 4 is read)`);
  if (body.length > 0xffff) throw malformed(`v4 public key packet of ${body.length} bytes`);
  const fingerprint = createHash('sha1').update(Uint8Array.of(0x99, body.length >> 8, body.length & 0xff)).update(body).digest('hex').toUpperCase();
  return { version: 4, created: new Date(u32(body, 1) * 1000), algorithm: body[5]!, body, fingerprint, keyId: fingerprint.slice(24) };
}

export type KeyMaterial =
  | { kind: 'rsa'; n: Uint8Array; e: Uint8Array; bits: number }
  | { kind: 'ed25519'; point: Uint8Array };

/** OID 1.3.6.1.4.1.11591.15.1, the Ed25519 curve of EdDSA (algorithm 22) keys. */
const ED25519_OID = Uint8Array.of(0x2b, 0x06, 0x01, 0x04, 0x01, 0xda, 0x47, 0x0f, 0x01);

/** The algorithm-specific part of a key; any algorithm but RSA (1), EdDSA over Ed25519 (22) and Ed25519 (27) is unsupported. */
export function keyMaterial(key: PublicKey): KeyMaterial {
  const body = key.body;
  switch (key.algorithm) {
    case 1: {
      const [n, afterN] = readMpi(body, 6);
      const [e, end] = readMpi(body, afterN);
      if (end !== body.length) throw malformed(`${body.length - end} bytes follow the RSA key material`);
      const modulus = stripLeadingZeros(n);
      const exponent = stripLeadingZeros(e);
      if (modulus.length === 0 || exponent.length === 0) throw malformed('RSA key with a zero modulus or exponent');
      return { kind: 'rsa', n: modulus, e: exponent, bits: bitLength(modulus) };
    }
    case 22: {
      const oidLength = body[6];
      if (oidLength === undefined || oidLength === 0 || oidLength === 0xff || 7 + oidLength > body.length) throw malformed('EdDSA key with a malformed curve OID');
      const oid = body.subarray(7, 7 + oidLength);
      if (hex(oid) !== hex(ED25519_OID)) throw unsupported(`EdDSA curve with OID ${hex(oid)} (only Ed25519 is read)`);
      const [point, end] = readMpi(body, 7 + oidLength);
      if (end !== body.length) throw malformed(`${body.length - end} bytes follow the EdDSA key material`);
      if (point.length !== 33 || point[0] !== 0x40) throw malformed('the EdDSA point is not 0x40 followed by 32 bytes');
      return { kind: 'ed25519', point: point.subarray(1) };
    }
    case 27: {
      if (body.length !== 6 + 32) throw malformed(`Ed25519 key material of ${body.length - 6} bytes, not 32`);
      return { kind: 'ed25519', point: body.subarray(6) };
    }
    default:
      throw unsupported(`public-key algorithm ${publicKeyAlgorithmName(key.algorithm)} is not supported`);
  }
}

function keyObject(material: KeyMaterial): KeyObject {
  try {
    if (material.kind === 'rsa') {
      return createPublicKey({ key: { kty: 'RSA', n: Buffer.from(material.n).toString('base64url'), e: Buffer.from(material.e).toString('base64url') }, format: 'jwk' });
    }
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(material.point).toString('base64url') }, format: 'jwk' });
  } catch (error) {
    throw malformed(`node:crypto rejects the key material: ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Signatures

export interface Subpacket {
  type: number;
  critical: boolean;
  hashed: boolean;
  data: Uint8Array;
}

export interface Signature {
  version: 4;
  type: number;
  publicKeyAlgorithm: number;
  hashAlgorithm: number;
  /** Version through the hashed subpackets: the part of the packet the signature itself covers. */
  hashedPart: Uint8Array;
  subpackets: Subpacket[];
  /** The left 16 bits of the signed digest, a quick check stated in the packet. */
  left16: Uint8Array;
  /** RSA: [s]; EdDSA (22): [r, s]; Ed25519 (27): [the 64-byte signature]; any other algorithm: [the raw remainder]. */
  values: Uint8Array[];
  created: Date;
  /** Seconds after `created` the signature expires (hashed subpacket 3); null when it does not. */
  expiresAfter: number | null;
  /** Seconds after the key's creation the key expires (hashed subpacket 9); null when it does not. */
  keyExpiresAfter: number | null;
  /** First byte of the key flags (hashed subpacket 27); null when absent. */
  keyFlags: number | null;
  issuerKeyIds: string[];
  /** Issuer fingerprints (subpacket 33) of v4 keys, 40 upper-case hex digits; other key versions read as "v<N>:<hex>". */
  issuerFingerprints: string[];
  /** Bodies of embedded signatures (subpacket 32), such as a subkey's primary key binding signature. */
  embedded: Uint8Array[];
}

/**
 * Subpacket types whose meaning this reader knows; a hashed subpacket marked critical with any other
 * type makes the signature unusable (RFC 9580 section 5.2.3.7).
 */
const UNDERSTOOD_SUBPACKETS = new Set([2, 3, 4, 7, 9, 11, 16, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 34, 39]);

function readSubpackets(area: Uint8Array, hashed: boolean): Subpacket[] {
  const subpackets: Subpacket[] = [];
  let at = 0;
  while (at < area.length) {
    const octet = area[at++]!;
    let length: number;
    if (octet < 192) length = octet;
    else if (octet < 255) {
      if (at >= area.length) throw malformed('subpacket length is cut short');
      length = ((octet - 192) << 8) + area[at++]! + 192;
    } else {
      length = u32(area, at);
      at += 4;
    }
    if (length === 0) throw malformed('subpacket of length 0');
    if (length > area.length - at) throw malformed(`subpacket of ${length} bytes extends past its area`);
    const typeByte = area[at]!;
    subpackets.push({ type: typeByte & 0x7f, critical: (typeByte & 0x80) !== 0, hashed, data: area.subarray(at + 1, at + length) });
    at += length;
  }
  return subpackets;
}

function readSignatureValues(algorithm: number, body: Uint8Array, at: number): Uint8Array[] {
  switch (algorithm) {
    case 1: {
      const [s, end] = readMpi(body, at);
      if (end !== body.length) throw malformed(`${body.length - end} bytes follow the RSA signature`);
      return [s];
    }
    case 22: {
      const [r, afterR] = readMpi(body, at);
      const [s, end] = readMpi(body, afterR);
      if (end !== body.length) throw malformed(`${body.length - end} bytes follow the EdDSA signature`);
      return [r, s];
    }
    case 27: {
      if (body.length - at !== 64) throw malformed(`Ed25519 signature of ${body.length - at} bytes, not 64`);
      return [body.subarray(at)];
    }
    default:
      return [body.subarray(at)];
  }
}

/** Reads a v4 signature packet body; v3, v5 and v6 signatures are unsupported. */
export function parseSignature(body: Uint8Array): Signature {
  if (body.length === 0) throw malformed('empty signature packet');
  if (body[0] !== 4) throw unsupported(`signature version ${body[0]} (only version 4 is read)`);
  if (body.length < 6) throw malformed(`v4 signature packet of ${body.length} bytes`);
  const hashedEnd = 6 + u16(body, 4);
  const unhashedEnd = hashedEnd + 2 + u16(body, hashedEnd);
  if (unhashedEnd + 2 > body.length) throw malformed('the signature subpacket areas extend past the packet');
  const subpackets = [
    ...readSubpackets(body.subarray(6, hashedEnd), true),
    ...readSubpackets(body.subarray(hashedEnd + 2, unhashedEnd), false),
  ];
  for (const subpacket of subpackets) {
    if (subpacket.hashed && subpacket.critical && !UNDERSTOOD_SUBPACKETS.has(subpacket.type)) {
      throw unsupported(`the signature has a critical subpacket of type ${subpacket.type}, which this reader does not evaluate`);
    }
  }
  const hashedOnce = (type: number, size: number | null, what: string): Uint8Array | null => {
    const found = subpackets.filter(subpacket => subpacket.hashed && subpacket.type === type);
    if (found.length > 1) throw malformed(`the signature has ${found.length} hashed ${what} subpackets`);
    const data = found[0]?.data ?? null;
    if (data && size !== null && data.length !== size) throw malformed(`${what} subpacket of ${data.length} bytes, not ${size}`);
    if (data && size === null && data.length === 0) throw malformed(`empty ${what} subpacket`);
    return data;
  };
  const created = hashedOnce(2, 4, 'creation time');
  if (!created) throw malformed('the signature has no creation time in its hashed subpackets');
  const seconds = (data: Uint8Array | null) => {
    const value = data ? u32(data, 0) : 0;
    return value === 0 ? null : value;
  };
  const flags = hashedOnce(27, null, 'key flags');
  const issuerKeyIds: string[] = [];
  const issuerFingerprints: string[] = [];
  const embedded: Uint8Array[] = [];
  for (const subpacket of subpackets) {
    if (subpacket.type === 16) {
      if (subpacket.data.length !== 8) throw malformed(`issuer key ID subpacket of ${subpacket.data.length} bytes`);
      issuerKeyIds.push(hex(subpacket.data).toUpperCase());
    } else if (subpacket.type === 33) {
      const version = subpacket.data[0];
      if (version === undefined) throw malformed('empty issuer fingerprint subpacket');
      if (version === 4) {
        if (subpacket.data.length !== 21) throw malformed(`v4 issuer fingerprint subpacket of ${subpacket.data.length} bytes`);
        issuerFingerprints.push(hex(subpacket.data.subarray(1)).toUpperCase());
      } else {
        issuerFingerprints.push(`v${version}:${hex(subpacket.data.subarray(1)).toUpperCase()}`);
      }
    } else if (subpacket.type === 32) {
      embedded.push(subpacket.data);
    }
  }
  return {
    version: 4,
    type: body[1]!,
    publicKeyAlgorithm: body[2]!,
    hashAlgorithm: body[3]!,
    hashedPart: body.subarray(0, hashedEnd),
    subpackets,
    left16: body.subarray(unhashedEnd, unhashedEnd + 2),
    values: readSignatureValues(body[2]!, body, unhashedEnd + 2),
    created: new Date(u32(created, 0) * 1000),
    expiresAfter: seconds(hashedOnce(3, 4, 'signature expiration time')),
    keyExpiresAfter: seconds(hashedOnce(9, 4, 'key expiration time')),
    keyFlags: flags ? flags[0]! : null,
    issuerKeyIds,
    issuerFingerprints,
    embedded,
  };
}

/** What a v4 signature appends to the signed data: its hashed part, then 0x04 0xFF and that part's length in four bytes. */
export function signatureTrailer(signature: Signature): Uint8Array {
  return concat([signature.hashedPart, Uint8Array.of(0x04, 0xff), be32(signature.hashedPart.length)]);
}

/** RSA keys shorter than this are refused. */
const MIN_RSA_BITS = 2048;

/**
 * Checks `signature` by `key` over `signedData` (the document, or the key and user ID material of a
 * key signature): the hash input is the data, the hashed part and the trailer; the left 16 bits of
 * the digest must match the packet's quick check; RSA is PKCS#1 v1.5 over the hash input, Ed25519
 * signs the digest. Throws OpenPgpError when the signature does not hold.
 */
export function verifySignature(key: PublicKey, signature: Signature, signedData: Uint8Array): void {
  if (signature.publicKeyAlgorithm !== key.algorithm) {
    throw invalid(`the signature uses ${publicKeyAlgorithmName(signature.publicKeyAlgorithm)}, key ${key.fingerprint} is ${publicKeyAlgorithmName(key.algorithm)}`);
  }
  const material = keyMaterial(key);
  const hash = HASH_ALGORITHMS[signature.hashAlgorithm];
  if (!hash?.node) throw unsupported(`hash algorithm ${hashAlgorithmName(signature.hashAlgorithm)} is not supported`);
  const input = concat([signedData, signatureTrailer(signature)]);
  const digest = createHash(hash.node).update(input).digest();
  if (digest[0] !== signature.left16[0] || digest[1] !== signature.left16[1]) {
    throw invalid(`the ${hash.name} digest begins ${hex(digest.subarray(0, 2))}, the signature's quick check states ${hex(signature.left16)}`);
  }
  let verified: boolean;
  if (material.kind === 'rsa') {
    if (material.bits < MIN_RSA_BITS) throw unsupported(`RSA key ${key.fingerprint} has ${material.bits} bits, below the ${MIN_RSA_BITS}-bit minimum`);
    const value = stripLeadingZeros(signature.values[0]!);
    if (value.length > material.n.length) throw invalid('the RSA signature is longer than the modulus');
    // OpenSSL wants the signature exactly as long as the modulus; the MPI drops leading zero bytes.
    verified = safeVerify(() => cryptoVerify(hash.node!, input, keyObject(material), leftPad(value, material.n.length)));
  } else {
    if (signature.hashAlgorithm === 11) throw unsupported('Ed25519 signatures need a hash of at least 256 bits; this one uses SHA224');
    let native: Uint8Array;
    if (signature.publicKeyAlgorithm === 22) {
      const [r, s] = signature.values.map(stripLeadingZeros);
      if (!r || !s || r.length > 32 || s.length > 32) throw malformed('EdDSA signature values longer than 32 bytes');
      native = concat([leftPad(r, 32), leftPad(s, 32)]);
    } else {
      native = signature.values[0]!;
    }
    verified = safeVerify(() => cryptoVerify(null, digest, keyObject(material), native));
  }
  if (!verified) throw invalid(`the signature does not verify with key ${key.fingerprint}`);
}

function safeVerify(run: () => boolean): boolean {
  try {
    return run();
  } catch (error) {
    if (error instanceof OpenPgpError) throw error;
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Transferable public keys (RFC 9580 section 10.1)

/** A signature packet as read from a key: parsed, or the reason it could not be (with its type byte when known). */
export type KeySignature = { ok: true; type: number; signature: Signature } | { ok: false; type: number | null; error: string };

export interface UserIdBlock {
  /** Packet body: a UTF-8 user ID (tag 13) or a user attribute (tag 17). */
  body: Uint8Array;
  attribute: boolean;
  signatures: KeySignature[];
}

export interface SubkeyBlock {
  key: PublicKey;
  signatures: KeySignature[];
}

export interface Certificate {
  primary: PublicKey;
  /** Signatures directly on the primary key: direct-key (0x1F) and key revocation (0x20). */
  direct: KeySignature[];
  userIds: UserIdBlock[];
  subkeys: SubkeyBlock[];
}

function keySignature(body: Uint8Array): KeySignature {
  try {
    const signature = parseSignature(body);
    return { ok: true, type: signature.type, signature };
  } catch (error) {
    // v3 signatures keep their type at offset 2, v4 and later at offset 1.
    const type = body[0] === 3 ? body[2] ?? null : body[1] ?? null;
    return { ok: false, type, error: (error as Error).message };
  }
}

/**
 * The keys in a binary or armored ("PUBLIC KEY BLOCK") key file or keyring. A signature packet this
 * reader cannot parse is kept with its error: it never makes a key valid, and when it is a revocation
 * it makes the key unusable. Trust (12) and marker (10) packets are skipped; any other packet that
 * does not belong in a public key is an error.
 */
export function readCertificates(input: Uint8Array): Certificate[] {
  let data = input;
  const start = Buffer.from(input.subarray(0, 64)).toString('latin1').trimStart();
  if (start.startsWith('-----BEGIN PGP')) {
    const armor = dearmor(new TextDecoder('utf-8', { fatal: true }).decode(input));
    if (armor.label !== 'PUBLIC KEY BLOCK') throw malformed(`armored ${armor.label}, not a PUBLIC KEY BLOCK`);
    data = armor.data;
  }
  const certificates: Certificate[] = [];
  let current: Certificate | null = null;
  let signatures: KeySignature[] | null = null;
  for (const packet of readPackets(data)) {
    if (packet.tag === 12 || packet.tag === 10) continue;
    if (packet.tag === 6) {
      current = { primary: parsePublicKey(packet.body), direct: [], userIds: [], subkeys: [] };
      certificates.push(current);
      signatures = current.direct;
      continue;
    }
    if (!current || !signatures) throw malformed(`packet of tag ${packet.tag} at offset ${packet.offset} precedes any public key`);
    if (packet.tag === 13 || packet.tag === 17) {
      const block: UserIdBlock = { body: packet.body, attribute: packet.tag === 17, signatures: [] };
      current.userIds.push(block);
      signatures = block.signatures;
    } else if (packet.tag === 14) {
      const block: SubkeyBlock = { key: parsePublicKey(packet.body), signatures: [] };
      current.subkeys.push(block);
      signatures = block.signatures;
    } else if (packet.tag === 2) {
      signatures.push(keySignature(packet.body));
    } else {
      throw malformed(`packet of tag ${packet.tag} at offset ${packet.offset} does not belong in a public key`);
    }
  }
  if (certificates.length === 0) throw malformed('no public key packet');
  return certificates;
}

/** The bytes a key signature hashes for a v4 key: 0x99, the two-byte body length and the body. */
function keyHashData(key: PublicKey): Uint8Array {
  return concat([Uint8Array.of(0x99, key.body.length >> 8, key.body.length & 0xff), key.body]);
}

/** The bytes a certification hashes for a user ID (0xB4) or user attribute (0xD1): the tag octet, a four-byte length, the body. */
function userIdHashData(block: UserIdBlock): Uint8Array {
  return concat([Uint8Array.of(block.attribute ? 0xd1 : 0xb4), be32(block.body.length), block.body]);
}

/** Whether the signature names `key` as its issuer; null when it names no issuer at all. */
function namesIssuer(signature: Signature, key: PublicKey): boolean | null {
  if (signature.issuerFingerprints.length) return signature.issuerFingerprints.includes(key.fingerprint);
  if (signature.issuerKeyIds.length) return signature.issuerKeyIds.includes(key.keyId);
  return null;
}

const CERTIFICATIONS = new Set([0x10, 0x11, 0x12, 0x13]);

interface PrimaryState {
  /** Verified self-signatures that bind the primary key: user ID certifications and direct-key signatures. */
  bindings: Signature[];
  revoked: string | null;
}

/**
 * Self-signatures on the primary key. A key revocation by the primary key revokes the key at every
 * time; one this reader cannot evaluate (unparseable, or an unsupported algorithm) does too, so an
 * unread revocation never lets a key through. A certification revocation (0x30) retires the
 * certifications of its user ID made before it.
 */
function primaryState(certificate: Certificate): PrimaryState {
  const primary = certificate.primary;
  const keyData = keyHashData(primary);
  let revoked: string | null = null;
  const bindings: Signature[] = [];
  for (const entry of certificate.direct) {
    if (!entry.ok) {
      if (entry.type === 0x20) revoked ??= `has a key revocation signature that cannot be read (${entry.error})`;
      continue;
    }
    const signature = entry.signature;
    if (signature.type !== 0x1f && signature.type !== 0x20) continue;
    if (namesIssuer(signature, primary) === false) continue;
    try {
      verifySignature(primary, signature, keyData);
    } catch (error) {
      if (signature.type === 0x20 && (error as OpenPgpError).kind !== 'invalid') revoked ??= `has a key revocation signature that cannot be evaluated (${(error as Error).message})`;
      continue;
    }
    if (signature.type === 0x20) revoked ??= `was revoked by a signature made ${iso(signature.created)}`;
    else bindings.push(signature);
  }
  for (const block of certificate.userIds) {
    const data = concat([keyData, userIdHashData(block)]);
    const certifications: Signature[] = [];
    let retiredUntil = -Infinity;
    for (const entry of block.signatures) {
      if (!entry.ok) {
        if (entry.type === 0x30) retiredUntil = Infinity;
        continue;
      }
      const signature = entry.signature;
      if (!CERTIFICATIONS.has(signature.type) && signature.type !== 0x30) continue;
      if (namesIssuer(signature, primary) === false) continue;
      try {
        verifySignature(primary, signature, data);
      } catch (error) {
        if (signature.type === 0x30 && (error as OpenPgpError).kind !== 'invalid') retiredUntil = Infinity;
        continue;
      }
      if (signature.type === 0x30) retiredUntil = Math.max(retiredUntil, signature.created.getTime());
      else certifications.push(signature);
    }
    bindings.push(...certifications.filter(signature => signature.created.getTime() > retiredUntil));
  }
  return { bindings, revoked };
}

interface SubkeyBinding {
  signature: Signature;
  /** A valid primary key binding signature (0x19) by the subkey is embedded. */
  crossCertified: boolean;
}

function subkeyState(certificate: Certificate, block: SubkeyBlock): { bindings: SubkeyBinding[]; revoked: string | null } {
  const primary = certificate.primary;
  const data = concat([keyHashData(primary), keyHashData(block.key)]);
  let revoked: string | null = null;
  const bindings: SubkeyBinding[] = [];
  for (const entry of block.signatures) {
    if (!entry.ok) {
      if (entry.type === 0x28) revoked ??= `has a subkey revocation signature that cannot be read (${entry.error})`;
      continue;
    }
    const signature = entry.signature;
    if (signature.type !== 0x18 && signature.type !== 0x28) continue;
    if (namesIssuer(signature, primary) === false) continue;
    try {
      verifySignature(primary, signature, data);
    } catch (error) {
      if (signature.type === 0x28 && (error as OpenPgpError).kind !== 'invalid') revoked ??= `has a subkey revocation signature that cannot be evaluated (${(error as Error).message})`;
      continue;
    }
    if (signature.type === 0x28) {
      revoked ??= `was revoked by a signature made ${iso(signature.created)}`;
      continue;
    }
    let crossCertified = false;
    for (const body of signature.embedded) {
      try {
        const back = parseSignature(body);
        if (back.type !== 0x19) continue;
        verifySignature(block.key, back, data);
        crossCertified = true;
        break;
      } catch {
        // An embedded signature that does not verify leaves the subkey without a cross-certification.
      }
    }
    bindings.push({ signature, crossCertified });
  }
  return { bindings, revoked };
}

/** The newest binding created at or before `at` that has not itself expired by then. */
function inForce<T>(bindings: readonly T[], signatureOf: (binding: T) => Signature, at: Date): T | null {
  let best: T | null = null;
  for (const binding of bindings) {
    const signature = signatureOf(binding);
    const created = signature.created.getTime();
    if (created > at.getTime()) continue;
    if (signature.expiresAfter !== null && at.getTime() >= created + signature.expiresAfter * 1000) continue;
    if (best === null || created > signatureOf(best).created.getTime()) best = binding;
  }
  return best;
}

const expiry = (key: PublicKey, seconds: number | null) => seconds === null ? null : new Date(key.created.getTime() + seconds * 1000);

export type KeyValidity = { valid: true; expires: Date | null } | { valid: false; reason: string };

/**
 * Whether `key` (the certificate's primary key or one of its subkeys) may make a data signature at
 * time `at`: not revoked, created by then, bound by a self-signature in force then, not expired then,
 * and flagged for signing. A subkey also needs a valid subkey binding signature with the signing flag
 * and an embedded primary key binding signature by the subkey (cross-certification), as GnuPG requires.
 */
export function signingKeyValidity(certificate: Certificate, key: PublicKey, at: Date): KeyValidity {
  const primary = certificate.primary;
  const no = (reason: string): KeyValidity => ({ valid: false, reason });
  const state = primaryState(certificate);
  if (state.revoked) return no(`key ${primary.fingerprint} ${state.revoked}`);
  if (primary.created.getTime() > at.getTime()) return no(`key ${primary.fingerprint} was created ${iso(primary.created)}, after ${iso(at)}`);
  const binding = inForce(state.bindings, signature => signature, at);
  if (!binding) {
    return no(state.bindings.length
      ? `key ${primary.fingerprint} has no self-signature in force at ${iso(at)}`
      : `key ${primary.fingerprint} has no valid self-signature`);
  }
  const primaryExpires = expiry(primary, binding.keyExpiresAfter);
  if (primaryExpires && at.getTime() >= primaryExpires.getTime()) return no(`key ${primary.fingerprint} expired ${iso(primaryExpires)}, before ${iso(at)}`);
  if (key.fingerprint === primary.fingerprint) {
    if (binding.keyFlags !== null && (binding.keyFlags & 0x02) === 0) return no(`key ${primary.fingerprint} is not flagged for signing (key flags 0x${binding.keyFlags.toString(16)})`);
    return { valid: true, expires: primaryExpires };
  }
  const block = certificate.subkeys.find(candidate => candidate.key.fingerprint === key.fingerprint);
  if (!block) return no(`key ${key.fingerprint} is not part of ${primary.fingerprint}`);
  const subkey = subkeyState(certificate, block);
  if (subkey.revoked) return no(`subkey ${key.fingerprint} ${subkey.revoked}`);
  if (key.created.getTime() > at.getTime()) return no(`subkey ${key.fingerprint} was created ${iso(key.created)}, after ${iso(at)}`);
  const subBinding = inForce(subkey.bindings, entry => entry.signature, at);
  if (!subBinding) {
    return no(subkey.bindings.length
      ? `subkey ${key.fingerprint} has no binding signature in force at ${iso(at)}`
      : `subkey ${key.fingerprint} has no valid binding signature by ${primary.fingerprint}`);
  }
  const subExpires = expiry(key, subBinding.signature.keyExpiresAfter);
  if (subExpires && at.getTime() >= subExpires.getTime()) return no(`subkey ${key.fingerprint} expired ${iso(subExpires)}, before ${iso(at)}`);
  const flags = subBinding.signature.keyFlags;
  if (flags === null || (flags & 0x02) === 0) return no(`subkey ${key.fingerprint} is not flagged for signing`);
  if (!subBinding.crossCertified) return no(`subkey ${key.fingerprint} has no valid primary key binding signature (cross-certification)`);
  const expires = [primaryExpires, subExpires].filter((date): date is Date => date !== null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  return { valid: true, expires };
}

// ---------------------------------------------------------------------------------------------
// Document signatures

export type DocumentVerdict =
  | { status: 'good'; signer: PublicKey; primary: PublicKey; created: Date; keyExpires: Date | null; detail: string }
  | { status: 'bad'; detail: string }
  | { status: 'unknown-issuer'; detail: string };

function issuerText(signature: Signature): string {
  if (signature.issuerFingerprints.length) return `issuer fingerprint ${signature.issuerFingerprints.join(', ')}`;
  if (signature.issuerKeyIds.length) return `issuer key ID ${signature.issuerKeyIds.join(', ')}`;
  return 'no issuer subpacket';
}

/**
 * A document signature checked against the given (already pinned) certificates: its type must be one
 * of `types`, it must be created at or before `now` and not have expired by `now`, its issuer must be
 * one of the keys, the signature must verify, and the key must be valid both when the signature was
 * made and at `now`. `document` is the signed bytes, already canonicalized for a text signature.
 */
export function verifyDocumentSignature(certificates: readonly Certificate[], signature: Signature, document: Uint8Array, now: Date, types: readonly number[]): DocumentVerdict {
  const bad = (detail: string): DocumentVerdict => ({ status: 'bad', detail });
  if (!types.includes(signature.type)) {
    return bad(`signature type 0x${signature.type.toString(16).padStart(2, '0')}, expected ${types.map(type => `0x${type.toString(16).padStart(2, '0')}`).join(' or ')}`);
  }
  if (signature.created.getTime() > now.getTime()) return bad(`signature created ${iso(signature.created)}, after the time of the check ${iso(now)}`);
  if (signature.expiresAfter !== null) {
    const expires = new Date(signature.created.getTime() + signature.expiresAfter * 1000);
    if (now.getTime() >= expires.getTime()) return bad(`signature expired ${iso(expires)}`);
  }
  const keys = certificates.flatMap(certificate => [
    { certificate, key: certificate.primary },
    ...certificate.subkeys.map(block => ({ certificate, key: block.key })),
  ]);
  const candidates = signature.issuerFingerprints.length
    ? keys.filter(({ key }) => signature.issuerFingerprints.includes(key.fingerprint))
    : signature.issuerKeyIds.length
      ? keys.filter(({ key }) => signature.issuerKeyIds.includes(key.keyId))
      : keys;
  if (candidates.length === 0) return { status: 'unknown-issuer', detail: `signature by ${issuerText(signature)}, which is not a pinned key or subkey` };
  let failure: DocumentVerdict | null = null;
  for (const { certificate, key } of candidates) {
    try {
      verifySignature(key, signature, document);
    } catch (error) {
      failure = bad((error as Error).message);
      continue;
    }
    for (const at of [signature.created, now]) {
      const validity = signingKeyValidity(certificate, key, at);
      if (!validity.valid) return bad(validity.reason);
    }
    const validity = signingKeyValidity(certificate, key, now) as { valid: true; expires: Date | null };
    const role = key.fingerprint === certificate.primary.fingerprint ? 'primary key' : `subkey of ${certificate.primary.fingerprint}`;
    return {
      status: 'good', signer: key, primary: certificate.primary, created: signature.created, keyExpires: validity.expires,
      detail: `${publicKeyAlgorithmName(signature.publicKeyAlgorithm)}/${hashAlgorithmName(signature.hashAlgorithm)} signature made ${iso(signature.created)} by ${key.fingerprint} (${role})`,
    };
  }
  return failure ?? bad('no candidate key verified the signature');
}

/**
 * The bytes a canonical text signature (type 0x01) of a cleartext message covers, RFC 4880 section
 * 7.1: the dash-unescaped text with trailing spaces and tabs removed from every line (and a CR, as
 * GnuPG does), lines joined by CR LF, without a final line ending.
 */
export function canonicalText(text: string): Uint8Array {
  return new TextEncoder().encode(text.replace(/\r\n/g, '\n').split('\n').map(line => line.replace(/[ \t\r]+$/, '')).join('\r\n'));
}
