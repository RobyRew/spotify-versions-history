/**
 * JSON answers of the public API (v2): an ETag over the body (304 for a matching If-None-Match), a
 * short public cache, and CORS open to every origin, since every GET answer is public data.
 */
import { createHash } from 'node:crypto';

export function json(request: Request, body: unknown, options: { status?: number; maxAge?: number } = {}): Response {
  const text = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(text).digest('base64url').slice(0, 27)}"`;
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': `public, max-age=${options.maxAge ?? 60}`,
    'access-control-allow-origin': '*',
    etag,
  };
  const status = options.status ?? 200;
  if (status === 200 && request.headers.get('if-none-match')?.split(',').some(tag => tag.trim() === etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(text, { status, headers });
}

export function notFound(request: Request, message: string): Response {
  return json(request, { error: 'not_found', message }, { status: 404, maxAge: 30 });
}
