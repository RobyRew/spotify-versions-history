import { describe, expect, it } from 'vitest';
import { handle, parseRange, type R2BucketLike } from '../../worker/src/handler.ts';

const HASH = 'a'.repeat(64);
const KEY = `sha256/${HASH}/spotify-1.3.10.2586.g81a118a22460-windows-x64.exe`;
const BYTES = new TextEncoder().encode('0123456789');

function bucket(): R2BucketLike & { gets: unknown[] } {
  const gets: unknown[] = [];
  return {
    gets,
    head: async key => (key === KEY ? { size: BYTES.length, httpEtag: '"e1"' } : null),
    get: async (key, options) => {
      gets.push(options ?? null);
      if (key !== KEY) return null;
      const slice = options?.range ? BYTES.slice(options.range.offset, options.range.offset + options.range.length) : BYTES;
      return { size: BYTES.length, httpEtag: '"e1"', body: new Blob([slice]).stream() };
    },
  };
}
const request = (path: string, init: RequestInit = {}) => new Request(`https://spotify-versions-files.example.workers.dev${path}`, init);

describe('files Worker', () => {
  it('serves a stored copy as a download, cached for a year', async () => {
    const response = await handle(request(`/${KEY}`), bucket());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="spotify-1.3.10.2586.g81a118a22460-windows-x64.exe"');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('content-length')).toBe('10');
  });

  it('answers byte ranges, HEAD and If-None-Match', async () => {
    const files = bucket();
    const partial = await handle(request(`/${KEY}`, { headers: { range: 'bytes=2-4' } }), files);
    expect([partial.status, await partial.text(), partial.headers.get('content-range')]).toEqual([206, '234', 'bytes 2-4/10']);
    const head = await handle(request(`/${KEY}`, { method: 'HEAD' }), files);
    expect([head.status, head.headers.get('content-length')]).toEqual([200, '10']);
    expect((await handle(request(`/${KEY}`, { headers: { 'if-none-match': '"e1"' } }), files)).status).toBe(304);
    const bad = await handle(request(`/${KEY}`, { headers: { range: 'bytes=20-' } }), files);
    expect([bad.status, bad.headers.get('content-range')]).toEqual([416, 'bytes */10']);
  });

  it('refuses every other path and method', async () => {
    const files = bucket();
    expect((await handle(request(`/sha256/${HASH}/../secret`), files)).status).toBe(404);
    expect((await handle(request('/sha256/abc/file.exe'), files)).status).toBe(404);
    expect((await handle(request(`/sha256/${'b'.repeat(64)}/missing.exe`), files)).status).toBe(404);
    expect((await handle(request(`/${KEY}`, { method: 'PUT', body: 'x' }), files)).status).toBe(405);
    expect(await (await handle(request('/robots.txt'), files)).text()).toBe('User-agent: *\nDisallow: /\n');
    expect(files.gets).toHaveLength(0);
  });

  it('reads single ranges and serves the whole file for several', () => {
    expect(parseRange('bytes=0-', 10)).toEqual({ offset: 0, length: 10 });
    expect(parseRange('bytes=-3', 10)).toEqual({ offset: 7, length: 3 });
    expect(parseRange('bytes=5-100', 10)).toEqual({ offset: 5, length: 5 });
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBe('invalid');
    expect(parseRange(null, 10)).toBeNull();
  });
});
