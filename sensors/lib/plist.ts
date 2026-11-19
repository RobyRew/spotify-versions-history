/**
 * Property lists: Apple's binary format (bplist00) and the XML format, enough to read an app bundle's
 * Info.plist (dictionaries, arrays, strings, integers, booleans). Reals, dates and data blobs read as null.
 */
export type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };

function utf16be(bytes: Uint8Array): string {
  const swapped = Buffer.alloc(bytes.length);
  for (let i = 0; i + 1 < bytes.length; i += 2) { swapped[i] = bytes[i + 1]!; swapped[i + 1] = bytes[i]!; }
  return swapped.toString('utf16le');
}

export function parseBinaryPlist(data: Uint8Array): PlistValue {
  if (data.length < 40 || Buffer.from(data.subarray(0, 8)).toString('latin1') !== 'bplist00') throw new Error('Not a binary plist');
  const trailer = data.length - 32;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offsetSize = data[trailer + 6]!;
  const refSize = data[trailer + 7]!;
  const objectCount = Number(view.getBigUint64(trailer + 8));
  const top = Number(view.getBigUint64(trailer + 16));
  const tableOffset = Number(view.getBigUint64(trailer + 24));
  const uint = (at: number, size: number) => {
    if (at < 0 || at + size > data.length) throw new Error('plist read out of bounds');
    let value = 0;
    for (let i = 0; i < size; i++) value = value * 256 + data[at + i]!;
    return value;
  };
  const offsetOf = (ref: number) => {
    if (ref >= objectCount) throw new Error(`plist object ${ref} out of range`);
    return uint(tableOffset + ref * offsetSize, offsetSize);
  };
  // A length below 15 sits in the marker's low nibble; 15 means an int object with the real length follows.
  const lengthAt = (at: number, low: number): [length: number, start: number] => {
    if (low !== 0xf) return [low, at + 1];
    const size = 1 << (data[at + 1]! & 0xf);
    return [uint(at + 2, size), at + 2 + size];
  };
  const parse = (ref: number, depth: number): PlistValue => {
    if (depth > 64) throw new Error('plist nesting too deep');
    const at = offsetOf(ref);
    const marker = data[at]!;
    const low = marker & 0xf;
    switch (marker >> 4) {
      case 0x0: return low === 0x9 ? true : low === 0x8 ? false : null;
      case 0x1: return uint(at + 1, 1 << low);
      case 0x5: { const [length, start] = lengthAt(at, low); return Buffer.from(data.subarray(start, start + length)).toString('latin1'); }
      case 0x6: { const [length, start] = lengthAt(at, low); return utf16be(data.subarray(start, start + 2 * length)); }
      case 0xa: {
        const [length, start] = lengthAt(at, low);
        return Array.from({ length }, (_, i) => parse(uint(start + i * refSize, refSize), depth + 1));
      }
      case 0xd: {
        const [length, start] = lengthAt(at, low);
        const out: Record<string, PlistValue> = {};
        for (let i = 0; i < length; i++) {
          const key = parse(uint(start + i * refSize, refSize), depth + 1);
          out[String(key)] = parse(uint(start + (length + i) * refSize, refSize), depth + 1);
        }
        return out;
      }
      default: return null;
    }
  };
  return parse(top, 0);
}

const XML_ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

/** The top-level string, integer and boolean entries of an XML plist dictionary. */
export function parseXmlPlist(text: string): Record<string, PlistValue> {
  const out: Record<string, PlistValue> = {};
  const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, entity => XML_ENTITIES[entity] ?? entity);
  const pattern = /<key>([^<]*)<\/key>\s*(?:<string>([^<]*)<\/string>|<integer>(-?\d+)<\/integer>|<(true|false)\/>)/g;
  for (const match of text.matchAll(pattern)) {
    const key = decode(match[1]!);
    if (key in out) continue;
    out[key] = match[2] !== undefined ? decode(match[2]) : match[3] !== undefined ? Number(match[3]) : match[4] === 'true';
  }
  return out;
}

export function parsePlist(data: Uint8Array): Record<string, PlistValue> {
  if (Buffer.from(data.subarray(0, 8)).toString('latin1') === 'bplist00') {
    const value = parseBinaryPlist(data);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plist root is not a dictionary');
    return value;
  }
  return parseXmlPlist(Buffer.from(data).toString('utf8'));
}
