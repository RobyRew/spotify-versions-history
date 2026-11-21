/**
 * A strict DER reader (ITU-T X.690 section 10) for the signature structures the verifiers parse.
 *
 * It accepts only what DER allows: definite lengths in their shortest form, low tag numbers in the
 * one-byte form, primitive encodings of strings and times, and SEQUENCE/SET always constructed. Any
 * other input (indefinite lengths, a length running past the data, trailing bytes, non-minimal
 * INTEGER or OID encodings, a time without seconds or "Z") throws a DerError, so a caller can turn it
 * into a failed check instead of guessing what a malformed signature meant.
 */

export class DerError extends Error {
  override name = 'DerError';
}

export const CLASS = { universal: 0, application: 1, context: 2, private: 3 } as const;

/** Universal tag numbers used by X.509, CMS and Authenticode. */
export const TAG = {
  boolean: 1,
  integer: 2,
  bitString: 3,
  octetString: 4,
  null: 5,
  oid: 6,
  utf8String: 12,
  sequence: 16,
  set: 17,
  numericString: 18,
  printableString: 19,
  teletexString: 20,
  ia5String: 22,
  utcTime: 23,
  generalizedTime: 24,
  visibleString: 26,
  universalString: 28,
  bmpString: 30,
} as const;

const UNIVERSAL_NAMES: Readonly<Record<number, string>> = {
  1: 'BOOLEAN', 2: 'INTEGER', 3: 'BIT STRING', 4: 'OCTET STRING', 5: 'NULL', 6: 'OBJECT IDENTIFIER',
  12: 'UTF8String', 16: 'SEQUENCE', 17: 'SET', 18: 'NumericString', 19: 'PrintableString',
  20: 'TeletexString', 22: 'IA5String', 23: 'UTCTime', 24: 'GeneralizedTime', 26: 'VisibleString',
  28: 'UniversalString', 30: 'BMPString',
};

/** Universal types DER encodes only in the constructed form. */
const ALWAYS_CONSTRUCTED = new Set<number>([TAG.sequence, TAG.set]);
/** Universal types DER encodes only in the primitive form (strings and times included: X.690 10.2). */
const ALWAYS_PRIMITIVE = new Set<number>([1, 2, 3, 4, 5, 6, 12, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30]);

/** Deepest nesting `walk` follows; real signatures stay under 30 levels. */
const MAX_DEPTH = 64;

/** "SEQUENCE", "[0]", "[APPLICATION 3]"...: how error messages name a tag. */
export function tagLabel(tagClass: number, tagNumber: number): string {
  if (tagClass === CLASS.universal) return UNIVERSAL_NAMES[tagNumber] ?? `UNIVERSAL ${tagNumber}`;
  if (tagClass === CLASS.context) return `[${tagNumber}]`;
  return `[${tagClass === CLASS.application ? 'APPLICATION' : 'PRIVATE'} ${tagNumber}]`;
}

/** One DER element: its tag, and where its header and content lie in the buffer it was read from. */
export class DerElement {
  readonly tagClass: number;
  readonly tagNumber: number;
  readonly constructed: boolean;
  /** The buffer the element was read from. */
  readonly source: Uint8Array;
  /** Offset of the identifier octet in `source`. */
  readonly start: number;
  /** Offset of the first content octet in `source`. */
  readonly contentStart: number;
  /** Offset just past the last content octet in `source`. */
  readonly end: number;

  constructor(fields: { tagClass: number; tagNumber: number; constructed: boolean; source: Uint8Array; start: number; contentStart: number; end: number }) {
    this.tagClass = fields.tagClass;
    this.tagNumber = fields.tagNumber;
    this.constructed = fields.constructed;
    this.source = fields.source;
    this.start = fields.start;
    this.contentStart = fields.contentStart;
    this.end = fields.end;
  }

  /** The whole element: identifier, length and content octets. */
  get encoding(): Uint8Array {
    return this.source.subarray(this.start, this.end);
  }

  /** The content octets alone, without the identifier and length. */
  get content(): Uint8Array {
    return this.source.subarray(this.contentStart, this.end);
  }

  get length(): number {
    return this.end - this.contentStart;
  }

  get headerLength(): number {
    return this.contentStart - this.start;
  }

  /** "SEQUENCE", "[0]", "[APPLICATION 3]"...; for error messages. */
  get label(): string {
    return tagLabel(this.tagClass, this.tagNumber);
  }

  is(tagClass: number, tagNumber: number): boolean {
    return this.tagClass === tagClass && this.tagNumber === tagNumber;
  }

  isUniversal(tagNumber: number): boolean {
    return this.is(CLASS.universal, tagNumber);
  }

  isContext(tagNumber: number): boolean {
    return this.is(CLASS.context, tagNumber);
  }

  /** The elements in the content of a constructed element; they must fill it exactly. */
  children(): DerElement[] {
    if (!this.constructed) throw new DerError(`${this.label} at offset ${this.start} is primitive and has no inner elements`);
    const items: DerElement[] = [];
    let at = this.contentStart;
    while (at < this.end) {
      const item = readElement(this.source, at, this.end);
      items.push(item);
      at = item.end;
    }
    return items;
  }
}

/**
 * Reads the element whose identifier octet is at `offset`; its content must end at or before `limit`.
 * Throws a DerError for anything DER does not allow.
 */
export function readElement(source: Uint8Array, offset = 0, limit = source.length): DerElement {
  if (!Number.isSafeInteger(offset) || offset < 0 || limit > source.length || offset >= limit) {
    throw new DerError(`no DER element at offset ${offset}: the data ends at ${limit}`);
  }
  let at = offset;
  const identifier = source[at++]!;
  const tagClass = identifier >> 6;
  const constructed = (identifier & 0x20) !== 0;
  let tagNumber = identifier & 0x1f;
  if (tagNumber === 0x1f) {
    // High tag number form: base-128, shortest form, and only for numbers that do not fit in five bits.
    tagNumber = 0;
    let first = true;
    for (;;) {
      if (at >= limit) throw new DerError(`tag at offset ${offset} runs past the end of the data`);
      const byte = source[at++]!;
      if (first && byte === 0x80) throw new DerError(`tag at offset ${offset} has a non-minimal high tag number`);
      first = false;
      tagNumber = tagNumber * 128 + (byte & 0x7f);
      if (tagNumber > 0x1fffff) throw new DerError(`tag at offset ${offset} has an unsupported tag number`);
      if ((byte & 0x80) === 0) break;
    }
    if (tagNumber < 0x1f) throw new DerError(`tag at offset ${offset} uses the high tag number form for ${tagNumber}`);
  }
  if (at >= limit) throw new DerError(`element at offset ${offset} has no length octet`);
  const first = source[at++]!;
  let length: number;
  if (first < 0x80) {
    length = first;
  } else if (first === 0x80) {
    throw new DerError(`element at offset ${offset} has an indefinite length, which DER does not allow`);
  } else if (first === 0xff) {
    throw new DerError(`element at offset ${offset} has the reserved length octet 0xFF`);
  } else {
    const count = first & 0x7f;
    if (count > 4) throw new DerError(`element at offset ${offset} has a ${count}-byte length, longer than any data this reader accepts`);
    if (at + count > limit) throw new DerError(`length of the element at offset ${offset} runs past the end of the data`);
    if (source[at] === 0) throw new DerError(`element at offset ${offset} has a length with a leading zero byte (not DER)`);
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + source[at++]!;
    if (length < 0x80) throw new DerError(`element at offset ${offset} uses the long form for the length ${length} (not DER)`);
  }
  const contentStart = at;
  const end = contentStart + length;
  if (end > limit) {
    throw new DerError(`element at offset ${offset} declares ${length} content bytes but only ${limit - contentStart} remain`);
  }
  if (tagClass === CLASS.universal) {
    if (tagNumber === 0) throw new DerError(`end-of-contents octets at offset ${offset}: DER has no indefinite lengths to end`);
    if (ALWAYS_CONSTRUCTED.has(tagNumber) && !constructed) throw new DerError(`${UNIVERSAL_NAMES[tagNumber]} at offset ${offset} is not constructed`);
    if (ALWAYS_PRIMITIVE.has(tagNumber) && constructed) throw new DerError(`${UNIVERSAL_NAMES[tagNumber] ?? `UNIVERSAL ${tagNumber}`} at offset ${offset} is constructed, which DER does not allow`);
  }
  return new DerElement({ tagClass, tagNumber, constructed, source, start: offset, contentStart, end });
}

/** The single element `bytes` holds; trailing bytes are an error. */
export function decodeDer(bytes: Uint8Array): DerElement {
  const element = readElement(bytes, 0, bytes.length);
  if (element.end !== bytes.length) throw new DerError(`${bytes.length - element.end} bytes follow the DER element that ends at offset ${element.end}`);
  return element;
}

/** Throws unless `element` has the given class, number and form. */
export function expectTag(element: DerElement, tagClass: number, tagNumber: number, what: string): DerElement {
  if (!element.is(tagClass, tagNumber)) {
    throw new DerError(`${what}: expected ${tagLabel(tagClass, tagNumber)}, found ${element.label} at offset ${element.start}`);
  }
  return element;
}

/** The children of a SEQUENCE. */
export function sequence(element: DerElement, what: string): DerElement[] {
  return expectTag(element, CLASS.universal, TAG.sequence, what).children();
}

/** The children of a SET. */
export function set(element: DerElement, what: string): DerElement[] {
  return expectTag(element, CLASS.universal, TAG.set, what).children();
}

/** Dotted form of an OBJECT IDENTIFIER, rejecting non-minimal and truncated subidentifiers. */
export function oid(element: DerElement, what = 'OBJECT IDENTIFIER'): string {
  expectTag(element, CLASS.universal, TAG.oid, what);
  const bytes = element.content;
  if (bytes.length === 0) throw new DerError(`${what}: empty OBJECT IDENTIFIER at offset ${element.start}`);
  const arcs: bigint[] = [];
  let value = 0n;
  let fresh = true;
  for (const byte of bytes) {
    if (fresh && byte === 0x80) throw new DerError(`${what}: non-minimal subidentifier in the OBJECT IDENTIFIER at offset ${element.start}`);
    fresh = false;
    value = (value << 7n) | BigInt(byte & 0x7f);
    if ((byte & 0x80) === 0) {
      arcs.push(value);
      value = 0n;
      fresh = true;
    }
  }
  if (!fresh) throw new DerError(`${what}: truncated OBJECT IDENTIFIER at offset ${element.start}`);
  const head = arcs[0]!;
  const first = head < 40n ? 0n : head < 80n ? 1n : 2n;
  return [first, head - first * 40n, ...arcs.slice(1)].join('.');
}

/** The two's-complement content octets of an INTEGER, which DER requires in their shortest form. */
export function integer(element: DerElement, what = 'INTEGER'): Uint8Array {
  expectTag(element, CLASS.universal, TAG.integer, what);
  const bytes = element.content;
  if (bytes.length === 0) throw new DerError(`${what}: empty INTEGER at offset ${element.start}`);
  if (bytes.length > 1 && ((bytes[0] === 0x00 && (bytes[1]! & 0x80) === 0) || (bytes[0] === 0xff && (bytes[1]! & 0x80) !== 0))) {
    throw new DerError(`${what}: INTEGER at offset ${element.start} is not in its shortest form`);
  }
  return bytes;
}

/** A non-negative INTEGER that fits in a JavaScript number (versions, counts). */
export function smallInteger(element: DerElement, what = 'INTEGER'): number {
  const bytes = integer(element, what);
  if ((bytes[0]! & 0x80) !== 0) throw new DerError(`${what}: negative INTEGER at offset ${element.start}`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new DerError(`${what}: INTEGER at offset ${element.start} is too large`);
  return Number(value);
}

export function octetString(element: DerElement, what = 'OCTET STRING'): Uint8Array {
  return expectTag(element, CLASS.universal, TAG.octetString, what).content;
}

/** A BIT STRING's unused-bit count and data octets; DER requires the unused bits to be zero. */
export function bitString(element: DerElement, what = 'BIT STRING'): { unusedBits: number; bytes: Uint8Array } {
  const content = expectTag(element, CLASS.universal, TAG.bitString, what).content;
  if (content.length === 0) throw new DerError(`${what}: BIT STRING at offset ${element.start} has no unused-bits octet`);
  const unusedBits = content[0]!;
  if (unusedBits > 7 || (content.length === 1 && unusedBits !== 0)) throw new DerError(`${what}: BIT STRING at offset ${element.start} declares ${unusedBits} unused bits`);
  const bytes = content.subarray(1);
  if (unusedBits > 0 && (bytes[bytes.length - 1]! & ((1 << unusedBits) - 1)) !== 0) {
    throw new DerError(`${what}: BIT STRING at offset ${element.start} has non-zero unused bits`);
  }
  return { unusedBits, bytes };
}

export function boolean(element: DerElement, what = 'BOOLEAN'): boolean {
  const content = expectTag(element, CLASS.universal, TAG.boolean, what).content;
  if (content.length !== 1 || (content[0] !== 0x00 && content[0] !== 0xff)) {
    throw new DerError(`${what}: BOOLEAN at offset ${element.start} is not 0x00 or 0xFF`);
  }
  return content[0] === 0xff;
}

export function nullValue(element: DerElement, what = 'NULL'): null {
  if (expectTag(element, CLASS.universal, TAG.null, what).length !== 0) throw new DerError(`${what}: NULL at offset ${element.start} has content`);
  return null;
}

const UTC_TIME = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/;
const GENERALIZED_TIME = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d*[1-9]))?Z$/;

function utcDate(year: number, month: number, day: number, hour: number, minute: number, second: number, millisecond: number, where: string): Date {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
  // Date.UTC rolls 31 February into March; the round trip rejects such impossible dates.
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    throw new DerError(`${where} is not a valid date and time`);
  }
  return date;
}

/**
 * UTCTime (YYMMDDHHMMSSZ, years 1950-2049 as RFC 5280 reads them) or GeneralizedTime
 * (YYYYMMDDHHMMSS[.fff]Z, a fraction without trailing zeros), as DER requires them.
 */
export function time(element: DerElement, what = 'time'): Date {
  const text = Buffer.from(element.content).toString('latin1');
  const where = `${what}: ${element.label} "${text}" at offset ${element.start}`;
  if (element.isUniversal(TAG.utcTime)) {
    const match = UTC_TIME.exec(text);
    if (!match) throw new DerError(`${where} is not YYMMDDHHMMSSZ`);
    const [yy, mo, dd, hh, mi, ss] = match.slice(1).map(Number) as [number, number, number, number, number, number];
    return utcDate(yy >= 50 ? 1900 + yy : 2000 + yy, mo, dd, hh, mi, ss, 0, where);
  }
  if (element.isUniversal(TAG.generalizedTime)) {
    const match = GENERALIZED_TIME.exec(text);
    if (!match) throw new DerError(`${where} is not YYYYMMDDHHMMSS[.fff]Z`);
    const [yyyy, mo, dd, hh, mi, ss] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const millisecond = match[7] ? Number(match[7].slice(0, 3).padEnd(3, '0')) : 0;
    return utcDate(yyyy, mo, dd, hh, mi, ss, millisecond, where);
  }
  throw new DerError(`${what}: expected UTCTime or GeneralizedTime, found ${element.label} at offset ${element.start}`);
}

const ASCII_STRINGS = new Set<number>([TAG.numericString, TAG.printableString, TAG.ia5String, TAG.visibleString]);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** The text of a directory string (UTF8String, PrintableString, IA5String, BMPString...). */
export function string(element: DerElement, what = 'string'): string {
  const bytes = element.content;
  if (element.tagClass !== CLASS.universal) throw new DerError(`${what}: expected a string, found ${element.label} at offset ${element.start}`);
  if (element.tagNumber === TAG.utf8String) {
    try { return UTF8.decode(bytes); } catch { throw new DerError(`${what}: UTF8String at offset ${element.start} is not valid UTF-8`); }
  }
  if (ASCII_STRINGS.has(element.tagNumber)) {
    if (bytes.some(byte => byte > 0x7f)) throw new DerError(`${what}: ${element.label} at offset ${element.start} holds non-ASCII bytes`);
    return Buffer.from(bytes).toString('latin1');
  }
  if (element.tagNumber === TAG.teletexString) return Buffer.from(bytes).toString('latin1');
  if (element.tagNumber === TAG.bmpString) {
    if (bytes.length % 2 !== 0) throw new DerError(`${what}: BMPString at offset ${element.start} has an odd length`);
    const swapped = Buffer.from(bytes);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (element.tagNumber === TAG.universalString) {
    if (bytes.length % 4 !== 0) throw new DerError(`${what}: UniversalString at offset ${element.start} is not a multiple of 4 bytes`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let text = '';
    for (let at = 0; at < bytes.length; at += 4) {
      const point = view.getUint32(at);
      if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) throw new DerError(`${what}: UniversalString at offset ${element.start} holds an invalid code point`);
      text += String.fromCodePoint(point);
    }
    return text;
  }
  throw new DerError(`${what}: expected a string, found ${element.label} at offset ${element.start}`);
}

/**
 * Calls `visit` for `element` and every element inside it, depth first, reading the content of
 * constructed elements only. Used by tests and diagnostics to locate structures.
 */
export function walk(element: DerElement, visit: (item: DerElement, depth: number) => void, depth = 0): void {
  if (depth > MAX_DEPTH) throw new DerError(`DER nesting deeper than ${MAX_DEPTH} levels at offset ${element.start}`);
  visit(element, depth);
  if (element.constructed) for (const child of element.children()) walk(child, visit, depth + 1);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex');
}
