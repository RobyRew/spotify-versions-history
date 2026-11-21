/**
 * A strict XML 1.0 reader for the machine-written documents the sensors and verifiers read: Windows
 * Update (FE3) SOAP envelopes and the escaped fragments inside them, APPX manifests and block maps.
 *
 * It reads elements, attributes, text, CDATA sections, comments, processing instructions and the XML
 * declaration, with the five predefined entities and numeric character references. It refuses what a
 * machine writer has no reason to produce and what would let a document mean two things: a document
 * type declaration (and with it every other entity), an undefined reference, a character XML does not
 * allow, a mismatched or unclosed tag, a duplicate attribute, a name with more than one colon, and
 * anything but comments and processing instructions outside the root element.
 *
 * Names are kept as written, prefix included ("s:Envelope"); namespaces are not resolved while parsing,
 * lookups go by local name, and namespaceOf resolves a prefix where a caller needs the URI. Line ends
 * are normalized to "\n" before parsing, as XML 1.0 requires, so error offsets count in the normalized
 * text.
 */

export class XmlError extends Error {
  /** Offset in the parsed (line-end normalized) text, or of the element a lookup failed on. */
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (XML offset ${offset})`);
    this.name = 'XmlError';
    this.offset = offset;
  }
}

export interface XmlElement {
  readonly kind: 'element';
  /** The name as written, with its prefix: "s:Envelope", "Identity". */
  readonly name: string;
  readonly prefix: string | null;
  readonly localName: string;
  /** Attribute values by the attribute name as written ("Name", "xmlns:s", "xml:lang"). */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  /** Offset of the "<" that opens the element. */
  readonly offset: number;
}

export interface XmlText {
  readonly kind: 'text';
  readonly text: string;
  /** True for the content of a CDATA section. */
  readonly cdata: boolean;
}

export interface XmlComment {
  readonly kind: 'comment';
  readonly text: string;
}

export interface XmlInstruction {
  readonly kind: 'instruction';
  readonly target: string;
  readonly data: string;
}

export type XmlNode = XmlElement | XmlText | XmlComment | XmlInstruction;

export interface XmlDeclaration {
  readonly version: string;
  readonly encoding: string | null;
  readonly standalone: boolean | null;
}

export interface XmlDocument {
  readonly declaration: XmlDeclaration | null;
  /** Comments and processing instructions before the root element. */
  readonly prolog: readonly XmlNode[];
  readonly root: XmlElement;
  /** Comments and processing instructions after the root element. */
  readonly epilog: readonly XmlNode[];
}

interface OpenElement {
  kind: 'element';
  name: string;
  prefix: string | null;
  localName: string;
  attributes: Record<string, string>;
  children: XmlNode[];
  offset: number;
}

/** Deeper nesting than this is refused; none of the documents read here comes close. */
export const MAX_XML_DEPTH = 256;

export const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';

const NAME_START = 'A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C\\u200D'
  + '\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const NAME_REST = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F\\u2040`;
/** The XML Name production; a colon is a name character there, qualified() then checks the QName rules. */
const NAME = new RegExp(`[:${NAME_START}][:${NAME_REST}]*`, 'uy');
const NCNAME = new RegExp(`^[${NAME_START}][${NAME_REST}]*$`, 'u');
const INVALID_CHARACTER = /[^\t\n\r\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u;
const SPACE = '[ \\t\\n]';
const DECLARATION = new RegExp(
  `<\\?xml${SPACE}+version${SPACE}*=${SPACE}*(?:"(1\\.[0-9]+)"|'(1\\.[0-9]+)')`
  + `(?:${SPACE}+encoding${SPACE}*=${SPACE}*(?:"([A-Za-z][A-Za-z0-9._-]*)"|'([A-Za-z][A-Za-z0-9._-]*)'))?`
  + `(?:${SPACE}+standalone${SPACE}*=${SPACE}*(?:"(yes|no)"|'(yes|no)'))?${SPACE}*\\?>`,
  'y',
);
const PREDEFINED: ReadonlyMap<string, string> = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]]);

function isXmlCharacter(code: number): boolean {
  return code === 0x9 || code === 0xa || code === 0xd || (code >= 0x20 && code <= 0xd7ff)
    || (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa;
}

/** Splits a QName; more than one colon, or an empty or malformed prefix or local part, is refused. */
function qualified(name: string, offset: number): { prefix: string | null; localName: string } {
  const colon = name.indexOf(':');
  if (colon === -1) return { prefix: null, localName: name };
  const prefix = name.slice(0, colon);
  const localName = name.slice(colon + 1);
  if (!NCNAME.test(prefix) || !NCNAME.test(localName)) throw new XmlError(`"${name}" is not a qualified name`, offset);
  return { prefix, localName };
}

function reference(body: string, offset: number): string {
  let code: number;
  if (/^#x[0-9A-Fa-f]+$/.test(body)) code = Number.parseInt(body.slice(2), 16);
  else if (/^#[0-9]+$/.test(body)) code = Number.parseInt(body.slice(1), 10);
  else {
    const character = PREDEFINED.get(body);
    if (character === undefined) throw new XmlError(`Undefined entity &${body};`, offset);
    return character;
  }
  if (!isXmlCharacter(code)) throw new XmlError(`&${body}; is not a character XML allows`, offset);
  return String.fromCodePoint(code);
}

/** Drops one leading byte order mark, normalizes line ends and refuses characters XML does not allow. */
function prepare(input: string): string {
  const text = (input.charCodeAt(0) === 0xfeff ? input.slice(1) : input).replace(/\r\n?/g, '\n');
  const invalid = INVALID_CHARACTER.exec(text);
  if (invalid) throw new XmlError(`Character U+${invalid[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} is not allowed in XML`, invalid.index);
  return text;
}

class Reader {
  readonly text: string;
  pos = 0;

  constructor(text: string) {
    this.text = text;
  }

  fail(message: string, offset = this.pos): never {
    throw new XmlError(message, offset);
  }

  at(token: string): boolean {
    return this.text.startsWith(token, this.pos);
  }

  expect(token: string): void {
    if (!this.at(token)) this.fail(`Expected "${token}"`);
    this.pos += token.length;
  }

  skipSpace(): boolean {
    const start = this.pos;
    while (isSpace(this.text.charCodeAt(this.pos))) this.pos++;
    return this.pos > start;
  }

  name(): string {
    NAME.lastIndex = this.pos;
    const match = NAME.exec(this.text);
    if (!match) this.fail('Expected a name');
    this.pos += match[0].length;
    return match[0];
  }

  /** Decodes references; in an attribute value a literal tab or line feed becomes a space (XML 1.0 §3.3.3). */
  references(raw: string, offset: number, attribute: boolean): string {
    const literal = attribute ? (part: string) => part.replace(/[\t\n]/g, ' ') : (part: string) => part;
    if (!raw.includes('&')) return literal(raw);
    let out = '';
    let last = 0;
    for (let amp = raw.indexOf('&'); amp !== -1; amp = raw.indexOf('&', last)) {
      out += literal(raw.slice(last, amp));
      const end = raw.indexOf(';', amp + 1);
      if (end === -1) this.fail('Unterminated reference', offset + amp);
      out += reference(raw.slice(amp + 1, end), offset + amp);
      last = end + 1;
    }
    return out + literal(raw.slice(last));
  }

  declaration(): XmlDeclaration | null {
    if (!this.text.startsWith('<?xml') || !/^[ \t\n?]$/.test(this.text[5] ?? '')) return null;
    DECLARATION.lastIndex = 0;
    const match = DECLARATION.exec(this.text);
    if (!match) this.fail('Malformed XML declaration', 0);
    this.pos = match[0].length;
    const standalone = match[5] ?? match[6];
    return { version: (match[1] ?? match[2])!, encoding: match[3] ?? match[4] ?? null, standalone: standalone === undefined ? null : standalone === 'yes' };
  }

  /** Comments, processing instructions and whitespace around the root element. */
  misc(): XmlNode[] {
    const nodes: XmlNode[] = [];
    for (;;) {
      this.skipSpace();
      if (this.at('<!--')) nodes.push(this.comment());
      else if (this.at('<?')) nodes.push(this.instruction());
      else if (this.at('<!DOCTYPE')) this.fail('Document type declarations are not accepted');
      else if (this.at('<!')) this.fail('Unexpected markup declaration');
      else return nodes;
    }
  }

  comment(): XmlComment {
    const start = this.pos;
    const end = this.text.indexOf('-->', start + 4);
    if (end === -1) this.fail('Unterminated comment', start);
    const text = this.text.slice(start + 4, end);
    if (text.includes('--') || text.endsWith('-')) this.fail('"--" inside a comment', start);
    this.pos = end + 3;
    return { kind: 'comment', text };
  }

  cdata(): XmlText {
    const start = this.pos;
    const end = this.text.indexOf(']]>', start + 9);
    if (end === -1) this.fail('Unterminated CDATA section', start);
    this.pos = end + 3;
    return { kind: 'text', text: this.text.slice(start + 9, end), cdata: true };
  }

  instruction(): XmlInstruction {
    const start = this.pos;
    this.pos += 2;
    const target = this.name();
    if (target.includes(':')) this.fail(`"${target}" is not a processing instruction target`, start);
    if (target.toLowerCase() === 'xml') this.fail('An XML declaration is only allowed at the start of a document', start);
    const end = this.text.indexOf('?>', this.pos);
    if (end === -1) this.fail('Unterminated processing instruction', start);
    let data = '';
    if (end > this.pos) {
      if (!this.skipSpace()) this.fail('Expected whitespace after the processing instruction target');
      data = this.text.slice(this.pos, end);
    }
    this.pos = end + 2;
    return { kind: 'instruction', target, data };
  }

  startTag(): { element: OpenElement; empty: boolean } {
    const offset = this.pos;
    this.pos++;
    const name = this.name();
    const element: OpenElement = { kind: 'element', name, ...qualified(name, offset), attributes: Object.create(null) as Record<string, string>, children: [], offset };
    for (;;) {
      const spaced = this.skipSpace();
      const code = this.text.charCodeAt(this.pos);
      if (code === 0x3e) {
        this.pos++;
        return { element, empty: false };
      }
      if (code === 0x2f) {
        this.pos++;
        this.expect('>');
        return { element, empty: true };
      }
      if (Number.isNaN(code)) this.fail(`Unterminated start tag <${name}>`, offset);
      if (!spaced) this.fail('Expected whitespace before an attribute');
      const at = this.pos;
      const attribute = this.name();
      qualified(attribute, at);
      this.skipSpace();
      this.expect('=');
      this.skipSpace();
      const quote = this.text[this.pos];
      if (quote !== '"' && quote !== "'") this.fail('Expected a quoted attribute value');
      const close = this.text.indexOf(quote, this.pos + 1);
      if (close === -1) this.fail(`Unterminated value of attribute ${attribute}`, at);
      const raw = this.text.slice(this.pos + 1, close);
      const lt = raw.indexOf('<');
      if (lt !== -1) this.fail('"<" in an attribute value', this.pos + 1 + lt);
      if (Object.hasOwn(element.attributes, attribute)) this.fail(`Duplicate attribute ${attribute}`, at);
      element.attributes[attribute] = this.references(raw, this.pos + 1, true);
      this.pos = close + 1;
    }
  }

  /**
   * Content up to the end tag of `root`, or for a fragment (root null) up to the end of the input.
   * Iterative, so the nesting depth is limited by MAX_XML_DEPTH and not by the call stack.
   */
  content(root: OpenElement | null): XmlNode[] {
    const top: XmlNode[] = [];
    const stack: OpenElement[] = root ? [root] : [];
    for (;;) {
      const parent = stack[stack.length - 1];
      const siblings = parent ? parent.children : top;
      if (this.pos >= this.text.length) {
        if (parent) this.fail(`Unclosed element <${parent.name}>`, parent.offset);
        return top;
      }
      const lt = this.text.indexOf('<', this.pos);
      const end = lt === -1 ? this.text.length : lt;
      if (end > this.pos) {
        const raw = this.text.slice(this.pos, end);
        const marker = raw.indexOf(']]>');
        if (marker !== -1) this.fail('"]]>" in character data', this.pos + marker);
        siblings.push({ kind: 'text', text: this.references(raw, this.pos, false), cdata: false });
        this.pos = end;
        continue;
      }
      if (this.at('</')) {
        const at = this.pos;
        this.pos += 2;
        const name = this.name();
        this.skipSpace();
        this.expect('>');
        const open = stack.pop();
        if (!open) this.fail(`End tag </${name}> without a start tag`, at);
        if (open.name !== name) this.fail(`End tag </${name}> does not close <${open.name}>`, at);
        if (root && stack.length === 0) return top;
      } else if (this.at('<!--')) siblings.push(this.comment());
      else if (this.at('<![CDATA[')) siblings.push(this.cdata());
      else if (this.at('<?')) siblings.push(this.instruction());
      else if (this.at('<!DOCTYPE')) this.fail('Document type declarations are not accepted');
      else if (this.at('<!')) this.fail('Unexpected markup declaration');
      else {
        const { element, empty } = this.startTag();
        siblings.push(element);
        if (!empty) {
          if (stack.length >= MAX_XML_DEPTH) this.fail(`Elements nested deeper than ${MAX_XML_DEPTH}`, element.offset);
          stack.push(element);
        }
      }
    }
  }
}

/** Parses a whole document: optional declaration, one root element, comments and PIs around it. */
export function parseXml(input: string): XmlDocument {
  const reader = new Reader(prepare(input));
  const declaration = reader.declaration();
  const prolog = reader.misc();
  if (reader.text[reader.pos] !== '<') reader.fail(reader.pos >= reader.text.length ? 'No root element' : 'Text before the root element');
  const { element, empty } = reader.startTag();
  if (!empty) reader.content(element);
  const epilog = reader.misc();
  if (reader.pos < reader.text.length) reader.fail('Content after the root element');
  return { declaration, prolog, root: element, epilog };
}

/**
 * Parses element content that is not a document: any number of elements, text, CDATA sections,
 * comments and processing instructions, as FE3 sends inside its <Xml> elements.
 */
export function parseXmlFragment(input: string): XmlNode[] {
  return new Reader(prepare(input)).content(null);
}

/**
 * Text of an XML file's bytes: UTF-8, or UTF-16 when a byte order mark says so. Invalid bytes, or an
 * encoding declaration that disagrees with the bytes, are an XmlError.
 */
export function decodeXml(bytes: Uint8Array): string {
  let encoding: 'utf-8' | 'utf-16le' | 'utf-16be' = 'utf-8';
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) [encoding, start] = ['utf-16le', 2];
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) [encoding, start] = ['utf-16be', 2];
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(start));
  } catch {
    throw new XmlError(`The bytes are not valid ${encoding.toUpperCase()}`, 0);
  }
  const declared = /^<\?xml[^>]*?[ \t\r\n]encoding[ \t\r\n]*=[ \t\r\n]*["']([A-Za-z][A-Za-z0-9._-]*)["']/.exec(text)?.[1]?.toLowerCase();
  const accepted = encoding === 'utf-8' ? ['utf-8'] : ['utf-16', encoding];
  if (declared !== undefined && !accepted.includes(declared)) {
    throw new XmlError(`The document declares encoding ${declared} but its bytes are ${encoding.toUpperCase()}`, 0);
  }
  return text;
}

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Escapes text for an element or a double- or single-quoted attribute value. */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => ESCAPES[character]!);
}

type Parent = XmlElement | readonly XmlNode[];

const nodesOf = (parent: Parent): readonly XmlNode[] => ('kind' in parent ? parent.children : parent);
const offsetOf = (parent: Parent): number => ('kind' in parent ? parent.offset : 0);
const label = (parent: Parent): string => ('kind' in parent ? `<${parent.name}>` : 'the fragment');

/** Child elements in document order, only those with `localName` when it is given. */
export function children(parent: Parent, localName?: string): XmlElement[] {
  return nodesOf(parent).filter((node): node is XmlElement => node.kind === 'element' && (localName === undefined || node.localName === localName));
}

/** The child element with this local name, or undefined; an XmlError when there are several. */
export function optionalChild(parent: Parent, localName: string): XmlElement | undefined {
  const found = children(parent, localName);
  if (found.length > 1) throw new XmlError(`${label(parent)} has ${found.length} <${localName}> elements, expected at most one`, offsetOf(parent));
  return found[0];
}

/** The one child element with this local name; an XmlError when there is none or several. */
export function onlyChild(parent: Parent, localName: string): XmlElement {
  const found = children(parent, localName);
  if (found.length !== 1) throw new XmlError(`${label(parent)} has ${found.length} <${localName}> elements, expected one`, offsetOf(parent));
  return found[0]!;
}

/** Text and CDATA content of an element that holds no child elements; comments and PIs are skipped. */
export function textOf(element: XmlElement): string {
  let text = '';
  for (const node of element.children) {
    if (node.kind === 'element') throw new XmlError(`<${element.name}> holds <${node.name}> where text was expected`, node.offset);
    if (node.kind === 'text') text += node.text;
  }
  return text;
}

/** True for a node that carries no content: whitespace text, a comment or a processing instruction. */
export function isBlank(node: XmlNode): boolean {
  return node.kind === 'comment' || node.kind === 'instruction' || (node.kind === 'text' && !node.cdata && /^[ \t\n]*$/.test(node.text));
}

/**
 * The namespace URI of an element, from the xmlns declarations on it and its ancestors (outermost
 * first, as a walk down from the root collects them). Null for no namespace; an XmlError for a prefix
 * that nothing declares.
 */
export function namespaceOf(element: XmlElement, ancestors: readonly XmlElement[]): string | null {
  const key = element.prefix === null ? 'xmlns' : `xmlns:${element.prefix}`;
  for (const scope of [element, ...[...ancestors].reverse()]) {
    const uri = scope.attributes[key];
    if (uri === undefined) continue;
    if (uri !== '') return uri;
    if (element.prefix === null) return null;
    throw new XmlError(`Prefix ${element.prefix} of <${element.name}> is bound to an empty URI`, element.offset);
  }
  if (element.prefix === null) return null;
  if (element.prefix === 'xml') return XML_NAMESPACE;
  throw new XmlError(`Prefix ${element.prefix} of <${element.name}> is not declared`, element.offset);
}
