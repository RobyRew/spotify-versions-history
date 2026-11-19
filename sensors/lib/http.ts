/** HTTP helpers for the sensors: an identifying User-Agent, timeouts, bounded retries, exact range reads. */
import type { Fetch } from '../types.ts';

export const USER_AGENT = 'spotify-versions-history-sensors/2 (+https://github.com/RobyRew/spotify-versions-history)';

export class HttpError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(`${url}: HTTP ${status}`);
    this.url = url;
    this.status = status;
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  /** Statuses treated as success. */
  accept?: number[];
  redirect?: 'follow' | 'error' | 'manual';
}

/** A 4xx other than 408 and 429 does not get better on retry. */
function retryable(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export async function request(fetchImpl: Fetch, url: string, options: RequestOptions = {}): Promise<Response> {
  const { method = 'GET', headers = {}, body, timeoutMs = 30_000, retries = 2, accept = [200], redirect = 'follow' } = options;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        method, body, redirect,
        headers: { 'user-agent': USER_AGENT, ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (accept.includes(response.status)) return response;
      await response.body?.cancel();
      const error = new HttpError(url, response.status);
      if (!retryable(response.status)) throw error;
      lastError = error;
    } catch (error) {
      if (error instanceof HttpError && !retryable(error.status)) throw error;
      lastError = error;
    }
    if (attempt < retries) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw lastError;
}

export interface HeadInfo {
  etag: string | null;
  size: number | null;
  lastModified: string | null;
  /** Google Cloud Storage object generation, when the host sends one. */
  generation: string | null;
}

export function headInfo(response: Response): HeadInfo {
  const size = Number(response.headers.get('content-length'));
  const modified = response.headers.get('last-modified');
  return {
    etag: response.headers.get('etag'),
    size: Number.isSafeInteger(size) && size > 0 ? size : null,
    lastModified: modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null,
    generation: response.headers.get('x-goog-generation'),
  };
}

/** HEAD on a permanent download URL; a redirect there is a change worth failing on. */
export async function head(fetchImpl: Fetch, url: string, options: RequestOptions = {}): Promise<HeadInfo> {
  const response = await request(fetchImpl, url, { method: 'HEAD', redirect: 'error', ...options });
  await response.body?.cancel();
  return headInfo(response);
}

export async function getText(fetchImpl: Fetch, url: string, options: RequestOptions = {}): Promise<string> {
  return (await request(fetchImpl, url, options)).text();
}

export async function getJson(fetchImpl: Fetch, url: string, options: RequestOptions = {}): Promise<unknown> {
  return (await request(fetchImpl, url, { ...options, headers: { accept: 'application/json', ...options.headers } })).json();
}

export async function getBytes(fetchImpl: Fetch, url: string, options: RequestOptions = {}): Promise<Uint8Array> {
  return new Uint8Array(await (await request(fetchImpl, url, options)).arrayBuffer());
}

/**
 * Bytes start..end (inclusive). With `ifMatch`, a file that changed since it was looked at answers 412
 * instead of mixing bytes of two builds.
 */
export async function getRange(fetchImpl: Fetch, url: string, start: number, end: number, ifMatch?: string | null): Promise<Uint8Array> {
  const response = await request(fetchImpl, url, {
    headers: { range: `bytes=${start}-${end}`, ...(ifMatch ? { 'if-match': ifMatch } : {}) },
    accept: [206],
    redirect: 'error',
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length !== end - start + 1) throw new Error(`${url}: range ${start}-${end} returned ${bytes.length} bytes`);
  return bytes;
}
