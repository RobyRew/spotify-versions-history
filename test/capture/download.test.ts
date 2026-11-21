// captureFile against in-memory fetches: streaming, digests, sizes, If-Match, redirects and timeouts.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureFile, claimedList, DigestMismatchError, RotatedError, SizeMismatchError } from '../../sensors/capture/download.ts';
import { HttpError, USER_AGENT } from '../../sensors/lib/http.ts';
import type { ClaimedDigests, Fetch } from '../../sensors/types.ts';
import { fakeFetch, type Call } from '../sensors/helpers.ts';

type Body = ConstructorParameters<typeof Response>[0];
const URL_X64 = 'https://download.scdn.co/SpotifyFullSetupX64.exe';
const ETAG = '"4da214887881217ff9c210c31b528a34"';
const bytes = new Uint8Array(randomBytes(300_000));
const hex = (algorithm: string, data: Uint8Array) => createHash(algorithm).update(data).digest('hex');
const all = {
  md5: hex('md5', bytes), sha1: hex('sha1', bytes), sha256: hex('sha256', bytes),
  sha512: hex('sha512', bytes), sha3_384: hex('sha3-384', bytes),
};

/** A fetch answering from a handler, recording every call the way fakeFetch does. */
function handlerFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: Fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    calls.push({ url, method: (init.method ?? 'GET').toUpperCase(), headers });
    return handler(url, init);
  };
  return { fetch: fetchImpl as Fetch, calls };
}

/** A body delivered in chunks of `size` bytes. */
function chunked(data: Uint8Array, size: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= data.length) { controller.close(); return; }
      controller.enqueue(data.slice(offset, offset + size));
      offset += size;
    },
  });
}

const ok = (body: Body, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers });

let directory = '';
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'svh-capture-')); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const destination = () => join(directory, 'SpotifyFullSetupX64.exe');
const leftovers = async () => (await readdir(directory)).filter(name => name !== 'SpotifyFullSetupX64.exe');

describe('captureFile', () => {
  it('streams the file to disk, computes the five digests in one pass and checks each claimed one', async () => {
    const { fetch, calls } = fakeFetch({
      [URL_X64]: { bytes, etag: ETAG, headers: { 'last-modified': 'Wed, 18 Nov 2026 13:09:13 GMT' } },
    });
    const captured = await captureFile(fetch, {
      url: URL_X64, destination: destination(), expectedSize: bytes.length, ifMatch: ETAG,
      claimed: { md5: all.md5.toUpperCase(), sha256: all.sha256 }, maxBytes: 1_000_000,
    }, { now: () => new Date('2026-11-20T13:00:00Z') });

    expect(captured).toMatchObject({
      path: destination(), url: URL_X64, finalUrl: URL_X64, size: bytes.length, digests: all,
      etag: ETAG, lastModified: '2026-11-18T13:09:13.000Z', fetchedAt: '2026-11-20T13:00:00.000Z',
    });
    expect(captured.checks.map(check => [check.id, check.status, check.verifier])).toEqual([
      ['digest.md5', 'pass', 'svh-capture/1'],
      ['digest.sha256', 'pass', 'svh-capture/1'],
    ]);
    expect(new Uint8Array(await readFile(destination()))).toEqual(bytes);
    expect(await leftovers()).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers).toMatchObject({ 'user-agent': USER_AGENT, 'if-match': ETAG, 'accept-encoding': 'identity' });
  });

  it('hashes a body that arrives in many chunks the same way', async () => {
    const { fetch } = handlerFetch(() => ok(chunked(bytes, 7_777), { 'content-length': String(bytes.length) }));
    const captured = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed: { sha512: all.sha512, sha3_384: all.sha3_384 }, maxBytes: 1_000_000 });
    expect(captured.digests).toEqual(all);
    expect(captured.checks.map(check => check.status)).toEqual(['pass', 'pass']);
  });

  it('deletes the temporary file and names algorithm, claim and actual value on a digest mismatch', async () => {
    const { fetch } = fakeFetch({ [URL_X64]: { bytes, etag: ETAG } });
    const claimed = { sha1: all.sha1, sha256: 'ab'.repeat(32) };
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(DigestMismatchError);
    expect(error).toMatchObject({ algorithm: 'sha256', claimed: 'ab'.repeat(32), actual: all.sha256 });
    expect((error as DigestMismatchError).checks.map(check => [check.id, check.status])).toEqual([['digest.sha1', 'pass'], ['digest.sha256', 'fail']]);
    expect((error as DigestMismatchError).checks[1]!.detail).toContain(all.sha256);
    expect(await readdir(directory)).toEqual([]);
  });

  it('throws RotatedError when If-Match answers 412', async () => {
    const { fetch } = fakeFetch({ [URL_X64]: { bytes, etag: '"newer"' } });
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), ifMatch: ETAG, claimed: {}, expectedSize: bytes.length, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(RotatedError);
    expect((error as RotatedError).ifMatch).toBe(ETAG);
    expect(await readdir(directory)).toEqual([]);
  });

  it('throws RotatedError when a 200 carries another ETag than the pinned one', async () => {
    const { fetch } = handlerFetch(() => ok(bytes, { etag: '"other"', 'content-length': String(bytes.length) }));
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), ifMatch: ETAG, claimed: {}, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(RotatedError);
    expect((error as RotatedError).etag).toBe('"other"');
  });

  it('refuses a size other than the expected one before reading the body', async () => {
    const { fetch } = fakeFetch({ [URL_X64]: { bytes, etag: ETAG } });
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), expectedSize: bytes.length + 1, claimed: {}, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(SizeMismatchError);
    expect(error.message).toMatch(/Content-Length 300000 is not the expected 300001/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses a body shorter than its Content-Length', async () => {
    const { fetch } = handlerFetch(() => ok(bytes.slice(0, 1000), { 'content-length': '2000' }));
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(SizeMismatchError);
    expect(error.message).toMatch(/received 1000 bytes, Content-Length said 2000/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses a Content-Length past maxBytes without reading the body', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; controller.enqueue(bytes); } });
    const { fetch } = handlerFetch(() => ok(body, { 'content-length': '5000000' }));
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(SizeMismatchError);
    expect(error.message).toMatch(/past the limit of 1000000 bytes/);
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('aborts a transfer without Content-Length once it passes maxBytes', async () => {
    let cancelled = false;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    });
    const { fetch } = handlerFetch(() => ok(endless));
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), expectedSize: 500_000, claimed: {}, maxBytes: 500_000 }).catch(e => e);
    expect(error).toBeInstanceOf(SizeMismatchError);
    expect(error.message).toMatch(/more than 500000 bytes received/);
    expect(cancelled).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  });

  it('refuses a response that states neither a length nor an expected size', async () => {
    const { fetch } = handlerFetch(() => ok(chunked(bytes, 1000)));
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: { sha256: all.sha256 }, maxBytes: 1_000_000 }))
      .rejects.toThrow(/no Content-Length and no expected size/);
  });

  it('refuses an encoded transfer', async () => {
    const { fetch } = handlerFetch(() => ok(bytes, { 'content-length': String(bytes.length), 'content-encoding': 'gzip' }));
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 })).rejects.toThrow(/Content-Encoding gzip/);
  });

  it('gives up when the body stalls for longer than the idle timeout', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.slice(0, 100)); },
      pull() { return new Promise(() => {}); },
    });
    const { fetch } = handlerFetch(() => ok(stalled, { 'content-length': String(bytes.length) }));
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 }, { idleTimeoutMs: 50 }).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/no data for 50 ms/);
    expect(await readdir(directory)).toEqual([]);
  });

  it('gives up when the response does not arrive within the idle timeout, even from a fetch that ignores the signal', async () => {
    const { fetch } = handlerFetch(() => new Promise<Response>(() => {}));
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 }, { idleTimeoutMs: 50 }))
      .rejects.toThrow(/no data for 50 ms/);
  });

  it('throws HttpError for an answer other than 200', async () => {
    const { fetch } = fakeFetch({});
    const error = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 }).catch(e => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(404);
  });
});

describe('captureFile redirects', () => {
  const snap = 'https://api.snapcraft.io/api/v1/snaps/download/pOBIoZ2LrCB3rDohMxoYGnbN14EHOgD7_99.snap';
  const cdn = 'https://canonical-lgw01.cdn.snapcraftcontent.com/download-origin/canonical-lgw01/pOBIoZ2LrCB3rDohMxoYGnbN14EHOgD7_99.snap?token=t';

  it('follows https redirects by hand and records the final URL', async () => {
    const { fetch, calls } = handlerFetch((url, init) => {
      expect(init.redirect).toBe('manual');
      if (url === snap) return new Response('moved', { status: 302, headers: { location: cdn } });
      if (url === cdn) return ok(bytes, { 'content-length': String(bytes.length) });
      return new Response('not found', { status: 404 });
    });
    const captured = await captureFile(fetch, { url: snap, destination: destination(), claimed: { sha3_384: all.sha3_384 }, maxBytes: 1_000_000 });
    expect(captured.finalUrl).toBe(cdn);
    expect(captured.url).toBe(snap);
    expect(captured.checks.map(check => [check.id, check.status])).toEqual([['digest.sha3_384', 'pass']]);
    expect(calls.map(call => call.url)).toEqual([snap, cdn]);
  });

  it('resolves a relative Location against the current URL', async () => {
    const { fetch } = handlerFetch(url => url === URL_X64
      ? new Response(null, { status: 301, headers: { location: '/mirror/SpotifyFullSetupX64.exe' } })
      : ok(bytes, { 'content-length': String(bytes.length) }));
    const captured = await captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 });
    expect(captured.finalUrl).toBe('https://download.scdn.co/mirror/SpotifyFullSetupX64.exe');
  });

  it('refuses a redirect from https to http', async () => {
    const { fetch, calls } = handlerFetch(() => new Response(null, { status: 302, headers: { location: 'http://download.scdn.co/SpotifyFullSetupX64.exe' } }));
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 })).rejects.toThrow(/which is not https/);
    expect(calls).toHaveLength(1);
  });

  it('stops after three redirects', async () => {
    let hop = 0;
    const { fetch, calls } = handlerFetch(() => new Response(null, { status: 302, headers: { location: `https://download.scdn.co/hop-${++hop}` } }));
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: {}, maxBytes: 1_000_000 })).rejects.toThrow(/more than 3 redirects/);
    expect(calls).toHaveLength(4);
  });
});

describe('captureFile http and claims', () => {
  const store = 'http://tlu.dl.delivery.mp.microsoft.com/filestreamingservice/files/0b4b5d3a-0000-0000-0000-000000000000?P1=1&P2=2';

  it('refuses an http URL unless allowHttp is set', async () => {
    const { fetch, calls } = fakeFetch({ [store]: { bytes, etag: '"x"' } });
    await expect(captureFile(fetch, { url: store, destination: destination(), claimed: { sha256: all.sha256 }, maxBytes: 1_000_000 })).rejects.toThrow(/only https/);
    expect(calls).toHaveLength(0);
  });

  it('refuses allowHttp without a claimed sha256 or sha1', async () => {
    const { fetch, calls } = fakeFetch({ [store]: { bytes, etag: '"x"' } });
    await expect(captureFile(fetch, { url: store, destination: destination(), claimed: { md5: all.md5 }, maxBytes: 1_000_000, allowHttp: true }))
      .rejects.toThrow(/allowHttp needs a claimed sha256 or sha1/);
    expect(calls).toHaveLength(0);
  });

  it('captures over http with allowHttp and a claimed sha256', async () => {
    const { fetch } = fakeFetch({ [store]: { bytes, etag: '"0yG6g0aKyZde074hVkLND/OaCfc="' } });
    const captured = await captureFile(fetch, { url: store, destination: destination(), claimed: { sha1: all.sha1, sha256: all.sha256 }, expectedSize: bytes.length, maxBytes: 1_000_000, allowHttp: true });
    expect(captured.checks.map(check => [check.id, check.status])).toEqual([['digest.sha1', 'pass'], ['digest.sha256', 'pass']]);
  });

  it('refuses a malformed or unknown claim before any request', async () => {
    const { fetch, calls } = fakeFetch({ [URL_X64]: { bytes, etag: ETAG } });
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: { sha256: 'abc' }, maxBytes: 1_000_000 })).rejects.toThrow(/not 64 hex digits/);
    await expect(captureFile(fetch, { url: URL_X64, destination: destination(), claimed: { sha224: 'ab'.repeat(28) } as ClaimedDigests, maxBytes: 1_000_000 }))
      .rejects.toThrow(/Unknown claimed digest "sha224"/);
    expect(calls).toHaveLength(0);
  });

  it('lists claims in a fixed order, lower-cased, skipping null and undefined ones', () => {
    const claimed = { sha256: all.sha256.toUpperCase(), md5: all.md5, sha1: null, sha512: undefined } as unknown as ClaimedDigests;
    expect(claimedList(claimed)).toEqual([['md5', all.md5], ['sha256', all.sha256]]);
  });
});
