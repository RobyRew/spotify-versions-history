/** Debian repository metadata: a clearsigned InRelease, its Release fields and hash lists, and Packages indexes. */

export interface Clearsigned {
  /** The signed text with dash-escaping removed, as gpgv checks it. */
  body: string;
  hash: string | null;
  signature: string;
}

export function parseClearsigned(text: string): Clearsigned {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '-----BEGIN PGP SIGNED MESSAGE-----') throw new Error('Not a clearsigned message');
  let index = 1;
  let hash: string | null = null;
  for (; index < lines.length && lines[index] !== ''; index++) {
    const match = /^Hash: (.+)$/.exec(lines[index]!);
    if (match) hash = match[1]!;
  }
  const signatureAt = lines.indexOf('-----BEGIN PGP SIGNATURE-----', index);
  if (signatureAt < 0) throw new Error('Clearsigned message without a signature');
  const body = lines.slice(index + 1, signatureAt).map(line => line.startsWith('- ') ? line.slice(2) : line).join('\n');
  return { body, hash, signature: lines.slice(signatureAt).join('\n') };
}

/** Debian control paragraphs; continuation lines join their field with a newline. */
export function parseControl(text: string): Record<string, string>[] {
  const paragraphs: Record<string, string>[] = [];
  let current: Record<string, string> = {};
  let field: string | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line.trim() === '') {
      if (Object.keys(current).length) paragraphs.push(current);
      current = {};
      field = null;
    } else if (/^[ \t]/.test(line) && field) {
      current[field] = current[field] ? `${current[field]}\n${line.trim()}` : line.trim();
    } else {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      field = line.slice(0, colon);
      current[field] = line.slice(colon + 1).trim();
    }
  }
  if (Object.keys(current).length) paragraphs.push(current);
  return paragraphs;
}

export interface ReleaseFile {
  fields: Record<string, string>;
  /** path -> { sha256, size } from the Release file's SHA256 list. */
  sha256: Map<string, { hash: string; size: number }>;
}

export function parseRelease(body: string): ReleaseFile {
  const fields = parseControl(body)[0] ?? {};
  const sha256 = new Map<string, { hash: string; size: number }>();
  for (const line of (fields.SHA256 ?? '').split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\d+)\s+(\S+)$/.exec(line.trim());
    if (match) sha256.set(match[3]!, { hash: match[1]!, size: Number(match[2]) });
  }
  return { fields, sha256 };
}
