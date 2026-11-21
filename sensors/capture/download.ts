/**
 * Downloads one file for the archive: the body is streamed to a temporary file beside its destination
 * while md5, sha1, sha256, sha512 and sha3-384 are computed in the same pass, and the file is renamed
 * into place only after its size and every digest the channel claimed were compared.
 *
 *  - Only https is used, unless `allowHttp` is set (the Microsoft Store download host has no HTTPS).
 *    allowHttp needs a claimed sha256 or sha1, so the bytes carried over plain http are bound to a
 *    digest the channel stated over TLS.
 *  - Redirects are followed by hand: at most three, each to https (or http with allowHttp).
 *  - With `ifMatch`, a file that changed upstream answers 412 and the capture throws RotatedError;
 *    a 200 carrying another ETag (a server or proxy that ignored If-Match) throws RotatedError too.
 *  - The received size must equal Content-Length and `expectedSize`; past `maxBytes` the transfer is
 *    aborted. A response that states neither a length nor an expected size is refused, since a
 *    truncated transfer could not be told from a complete one.
 *  - A digest that differs from its claim deletes the temporary file and throws DigestMismatchError.
 */
import { createHash, randomBytes, type Hash } from 'node:crypto';
import { mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { HttpError, USER_AGENT } from '../lib/http.ts';
import type { ClaimedDigests, Fetch } from '../types.ts';
import { fail, pass, type Check } from '../verify/types.ts';

export const CAPTURE_VERIFIER = 'svh-capture/1';
export const DIGEST_ALGORITHMS = ['md5', 'sha1', 'sha256', 'sha512', 'sha3_384'] as const;
export type DigestAlgorithm = (typeof DIGEST_ALGORITHMS)[number];
export type Digests = Record<DigestAlgorithm, string>;

/** Node's name for each algorithm and the length of its lower-case hex digest. */
const ALGORITHMS: Readonly<Record<DigestAlgorithm, { node: string; hexLength: number }>> = {
  md5: { node: 'md5', hexLength: 32 },
  sha1: { node: 'sha1', hexLength: 40 },
  sha256: { node: 'sha256', hexLength: 64 },
  sha512: { node: 'sha512', hexLength: 128 },
  sha3_384: { node: 'sha3-384', hexLength: 96 },
};
const MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface CaptureRequest {
  url: string;
  /** Where the verified file ends up; the temporary file is written in the same directory. */
  destination: string;
  expectedSize?: number | null;
  /** The ETag the file was catalogued with; sent as If-Match. */
  ifMatch?: string | null;
  claimed: ClaimedDigests;
  maxBytes: number;
  allowHttp?: boolean;
}

export interface CaptureOptions {
  /** Longest wait for the response headers or for the next chunk of the body (default 60 s). */
  idleTimeoutMs?: number;
  now?: () => Date;
}

export interface CapturedFile {
  path: string;
  url: string;
  /** The URL the bytes came from after redirects (the request URL when there was none). */
  finalUrl: string;
  size: number;
  digests: Digests;
  etag: string | null;
  lastModified: string | null;
  /** When the response headers arrived. */
  fetchedAt: string;
  /** One row per claimed digest, id "digest.<algorithm>". */
  checks: Check[];
}

/** The file behind the URL is no longer the one with the ETag the capture was asked to pin. */
export class RotatedError extends Error {
  readonly url: string;
  readonly ifMatch: string;
  /** The ETag the server answered with, when it sent one. */
  readonly etag: string | null;
  constructor(url: string, ifMatch: string, etag: string | null, message: string) {
    super(message);
    this.name = 'RotatedError';
    this.url = url;
    this.ifMatch = ifMatch;
    this.etag = etag;
  }
}

/** A downloaded file's digest differs from the one the channel claimed; nothing was kept. */
export class DigestMismatchError extends Error {
  readonly url: string;
  readonly algorithm: DigestAlgorithm;
  readonly claimed: string;
  readonly actual: string;
  /** Every digest row of the capture, the failing ones included. */
  readonly checks: Check[];
  constructor(url: string, algorithm: DigestAlgorithm, claimed: string, actual: string, checks: Check[]) {
    super(`${url}: ${ALGORITHMS[algorithm].node} is ${actual}, the channel claimed ${claimed}`);
    this.name = 'DigestMismatchError';
    this.url = url;
    this.algorithm = algorithm;
    this.claimed = claimed;
    this.actual = actual;
    this.checks = checks;
  }
}

/** The transfer was longer or shorter than Content-Length or the expected size, or past maxBytes. */
export class SizeMismatchError extends Error {
  readonly url: string;
  readonly expected: number | null;
  readonly actual: number;
  constructor(url: string, expected: number | null, actual: number, message: string) {
    super(`${url}: ${message}`);
    this.name = 'SizeMismatchError';
    this.url = url;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * The claimed digests in a fixed order, lower-cased. A claim that is not hex of its algorithm's length,
 * or names an algorithm this capture does not compute, throws: it could never be compared.
 */
export function claimedList(claimed: ClaimedDigests): [DigestAlgorithm, string][] {
  const known = new Set<string>(DIGEST_ALGORITHMS);
  for (const key of Object.keys(claimed)) {
    if (!known.has(key)) throw new Error(`Unknown claimed digest "${key}"`);
  }
  const list: [DigestAlgorithm, string][] = [];
  for (const algorithm of DIGEST_ALGORITHMS) {
    const value: unknown = claimed[algorithm];
    if (value === undefined || value === null) continue;
    const { hexLength } = ALGORITHMS[algorithm];
    if (typeof value !== 'string' || !new RegExp(`^[0-9a-fA-F]{${hexLength}}$`).test(value)) {
      throw new Error(`The claimed ${algorithm} is not ${hexLength} hex digits: ${JSON.stringify(value)}`);
    }
    list.push([algorithm, value.toLowerCase()]);
  }
  return list;
}

function schemeAllowed(url: URL, allowHttp: boolean): boolean {
  return url.protocol === 'https:' || (allowHttp && url.protocol === 'http:');
}

function parseUrl(value: string, base?: string): URL {
  try { return new URL(value, base); }
  catch { throw new Error(`Not a URL: ${value}`); }
}

/** Resolves when the signal aborts, with its reason; lets a fetch that ignores the signal still time out. */
function abortion(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** GET with redirects followed by hand; returns the first answer that is not a redirect. */
async function openFollowing(
  fetchImpl: Fetch, url: string, headers: Record<string, string>, allowHttp: boolean, signal: AbortSignal,
): Promise<{ response: Response; finalUrl: string }> {
  const aborted = abortion(signal);
  let current = url;
  for (let redirects = 0; ; redirects++) {
    const response = await Promise.race([fetchImpl(current, { method: 'GET', headers, redirect: 'manual', signal }), aborted]);
    if (!REDIRECT_STATUSES.has(response.status)) return { response, finalUrl: current };
    const location = response.headers.get('location');
    await discard(response);
    if (!location) throw new Error(`${current}: HTTP ${response.status} without a Location header`);
    if (redirects === MAX_REDIRECTS) throw new Error(`${url}: more than ${MAX_REDIRECTS} redirects`);
    const next = parseUrl(location, current);
    if (!schemeAllowed(next, allowHttp)) {
      throw new Error(`${current} redirects to ${next.href}, which is not ${allowHttp ? 'http or https' : 'https'}`);
    }
    current = next.href;
  }
}

function lastModifiedOf(response: Response): string | null {
  const value = response.headers.get('last-modified');
  const time = value === null ? Number.NaN : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function contentLengthOf(response: Response, url: string): number | null {
  const value = response.headers.get('content-length');
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) throw new Error(`${url}: unreadable Content-Length "${value}"`);
  return Number(trimmed);
}

export async function captureFile(fetchImpl: Fetch, request: CaptureRequest, options: CaptureOptions = {}): Promise<CapturedFile> {
  const { url, destination, maxBytes } = request;
  const allowHttp = request.allowHttp === true;
  const expectedSize = request.expectedSize ?? null;
  const ifMatch = request.ifMatch ?? null;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error(`maxBytes must be a positive integer, not ${maxBytes}`);
  if (expectedSize !== null && (!Number.isSafeInteger(expectedSize) || expectedSize < 0)) {
    throw new Error(`expectedSize must be a non-negative integer, not ${expectedSize}`);
  }
  if (expectedSize !== null && expectedSize > maxBytes) throw new SizeMismatchError(url, expectedSize, 0, `the expected size ${expectedSize} is past the limit of ${maxBytes} bytes`);
  const claims = claimedList(request.claimed);
  if (allowHttp && !claims.some(([algorithm]) => algorithm === 'sha256' || algorithm === 'sha1')) {
    throw new Error(`${url}: allowHttp needs a claimed sha256 or sha1 to bind the bytes`);
  }
  if (!schemeAllowed(parseUrl(url), allowHttp)) throw new Error(`${url}: only https URLs are captured${allowHttp ? ' (or http with allowHttp)' : ''}`);

  const headers: Record<string, string> = {
    'user-agent': USER_AGENT,
    // A transfer encoding would make the hashed bytes differ from the file.
    'accept-encoding': 'identity',
    ...(ifMatch !== null ? { 'if-match': ifMatch } : {}),
  };
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new Error(`${url}: no data for ${idleTimeoutMs} ms`)), idleTimeoutMs);
  };
  const temporary = join(dirname(destination), `.${basename(destination)}.${randomBytes(6).toString('hex')}.partial`);
  try {
    arm();
    const { response, finalUrl } = await openFollowing(fetchImpl, url, headers, allowHttp, controller.signal);
    arm();
    const fetchedAt = now().toISOString();
    const etag = response.headers.get('etag');
    if (response.status === 412 && ifMatch !== null) {
      await discard(response);
      throw new RotatedError(url, ifMatch, etag, `${finalUrl}: HTTP 412, the file no longer has ETag ${ifMatch}`);
    }
    if (response.status !== 200) {
      await discard(response);
      throw new HttpError(finalUrl, response.status);
    }
    if (ifMatch !== null && ifMatch !== '*' && etag !== null && etag !== ifMatch) {
      await discard(response);
      throw new RotatedError(url, ifMatch, etag, `${finalUrl}: answered with ETag ${etag}, not the pinned ${ifMatch}`);
    }
    const encoding = response.headers.get('content-encoding');
    if (encoding !== null && encoding.trim().toLowerCase() !== 'identity') {
      await discard(response);
      throw new Error(`${finalUrl}: Content-Encoding ${encoding}; the received bytes would not be the file`);
    }
    let contentLength: number | null;
    try { contentLength = contentLengthOf(response, finalUrl); }
    catch (error) { await discard(response); throw error; }
    if (contentLength === null && expectedSize === null) {
      await discard(response);
      throw new Error(`${finalUrl}: no Content-Length and no expected size, so a truncated transfer could not be detected`);
    }
    if (contentLength !== null && contentLength > maxBytes) {
      await discard(response);
      throw new SizeMismatchError(url, expectedSize, contentLength, `Content-Length ${contentLength} is past the limit of ${maxBytes} bytes`);
    }
    if (contentLength !== null && expectedSize !== null && contentLength !== expectedSize) {
      await discard(response);
      throw new SizeMismatchError(url, expectedSize, contentLength, `Content-Length ${contentLength} is not the expected ${expectedSize} bytes`);
    }

    const hashes: [DigestAlgorithm, Hash][] = DIGEST_ALGORITHMS.map(algorithm => [algorithm, createHash(ALGORITHMS[algorithm].node)]);
    let received = 0;
    const meter = new Transform({
      transform(chunk: Uint8Array, _encoding: BufferEncoding, callback: TransformCallback) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          const error = new SizeMismatchError(url, expectedSize, received, `more than ${maxBytes} bytes received`);
          controller.abort(error);
          callback(error);
          return;
        }
        for (const [, hash] of hashes) hash.update(chunk);
        arm();
        callback(null, chunk);
      },
    });
    // The file exists before the transfer starts, so a failed transfer cannot create it after the cleanup.
    // The stream owns the handle: it flushes the data to disk and closes the file when the body ends.
    let sink: ReturnType<FileHandle['createWriteStream']>;
    try {
      await mkdir(dirname(destination), { recursive: true });
      sink = (await open(temporary, 'wx')).createWriteStream({ flush: true });
    } catch (error) {
      await discard(response);
      throw error;
    }
    const body = response.body ? Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>) : Readable.from([]);
    try {
      await pipeline(body, meter, sink, { signal: controller.signal });
    } catch (error) {
      // Windows cannot delete a file that is still open; wait until the stream has let go of it.
      if (!sink.closed) await new Promise(resolve => sink.once('close', resolve));
      throw error;
    }
    clearTimeout(timer);
    if (contentLength !== null && received !== contentLength) {
      throw new SizeMismatchError(url, contentLength, received, `received ${received} bytes, Content-Length said ${contentLength}`);
    }
    if (expectedSize !== null && received !== expectedSize) {
      throw new SizeMismatchError(url, expectedSize, received, `received ${received} bytes, expected ${expectedSize}`);
    }
    const digests = Object.fromEntries(hashes.map(([algorithm, hash]) => [algorithm, hash.digest('hex')])) as Digests;
    const checks = claims.map(([algorithm, value]) => {
      const name = ALGORITHMS[algorithm].node;
      return digests[algorithm] === value
        ? pass(`digest.${algorithm}`, CAPTURE_VERIFIER, `${name} ${value} equals the claimed digest`)
        : fail(`digest.${algorithm}`, CAPTURE_VERIFIER, `expected the claimed ${name} ${value}, found ${digests[algorithm]}`);
    });
    const mismatch = claims.find(([algorithm, value]) => digests[algorithm] !== value);
    if (mismatch) throw new DigestMismatchError(url, mismatch[0], mismatch[1], digests[mismatch[0]], checks);
    await rename(temporary, destination);
    return { path: destination, url, finalUrl, size: received, digests, etag, lastModified: lastModifiedOf(response), fetchedAt, checks };
  } catch (error) {
    await rm(temporary, { force: true });
    // An abort surfaces as a generic AbortError; the reason says what happened (idle timeout, size limit).
    if (controller.signal.aborted && controller.signal.reason instanceof Error && !(error instanceof SizeMismatchError)) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
