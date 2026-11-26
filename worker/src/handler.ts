/**
 * The files Worker's request handling, kept free of Cloudflare's runtime so tests can run it with a
 * fake bucket. Only `/sha256/<64 hex>/<filename>` is served (GET and HEAD, single byte ranges,
 * If-None-Match); objects are written once by sensors/archive.ts and never change, so responses are
 * cached for a year. Anything else is 404, and robots are asked to stay away.
 */

export interface R2ObjectLike {
  size: number;
  httpEtag: string;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  body: ReadableStream;
}

export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2ObjectBodyLike | null>;
}

const PATH = /^\/(sha256\/[0-9a-f]{64}\/([A-Za-z0-9._-]{1,200}))$/;
const SITE = 'https://version-history.spotify.robyrew.com';

/** A single `bytes=` range against an object of `size` bytes: null (none), 'invalid', or offset and length. */
export function parseRange(header: string | null, size: number): { offset: number; length: number } | 'invalid' | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Several ranges, or another unit: serve the whole object, as the specification allows.
  if (!match) return header.includes(',') ? null : 'invalid';
  const [, from, to] = match;
  if (from === '' && to === '') return 'invalid';
  if (from === '') {
    const suffix = Math.min(Number(to), size);
    return suffix === 0 ? 'invalid' : { offset: size - suffix, length: suffix };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return 'invalid';
  return { offset: start, length: end - start + 1 };
}

function text(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff', ...extra } });
}

export async function handle(request: Request, bucket: R2BucketLike): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return text(405, 'Only GET and HEAD.\n', { allow: 'GET, HEAD' });
  const { pathname } = new URL(request.url);
  if (pathname === '/') return text(200, `Copies of official Spotify builds kept by the Spotify versions archive.\nBrowse them at ${SITE}\n`);
  if (pathname === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /\n');
  const match = PATH.exec(pathname);
  if (!match) return text(404, 'Not found.\n');
  const [, key, filename] = match;
  const head = await bucket.head(key!);
  if (!head) return text(404, 'This archive has no such file.\n');

  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${filename}"`,
    etag: head.httpEtag,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex, nofollow',
  };
  if (request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === head.httpEtag)) return new Response(null, { status: 304, headers });

  const range = parseRange(request.headers.get('range'), head.size);
  if (range === 'invalid') return text(416, 'Range not satisfiable.\n', { 'content-range': `bytes */${head.size}` });
  const status = range ? 206 : 200;
  if (range) headers['content-range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
  headers['content-length'] = String(range ? range.length : head.size);
  if (request.method === 'HEAD') return new Response(null, { status, headers });

  const object = await bucket.get(key!, range ? { range } : undefined);
  if (!object) return text(404, 'This archive has no such file.\n');
  return new Response(object.body, { status, headers });
}
