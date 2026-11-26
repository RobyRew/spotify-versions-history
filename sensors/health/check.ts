/**
 * Link health: one polite request per download link the ledger records, on a per-provider schedule.
 *
 *  - Spotify's current-build URLs, its apt pool and the Snap Store are checked on every run; signed
 *    upgrade.scdn.co links are decided from their token's `exp` without a request once expired.
 *  - The LoadSpot mirror, GitHub archive copies and other links are checked weekly: a run checks the
 *    links whose sha256(url) mod 7 equals the UTC day of the week, so the load spreads over the week.
 *  - At most 2 requests at a time go to the LoadSpot mirror and 4 to any other host, each followed by
 *    a short pause. Redirects are followed by hand (GitHub and the Snap Store redirect to signed CDN
 *    addresses, kept without their query); a host refusing HEAD gets a one-byte range GET instead.
 *
 * Results of links not checked in a run carry over from the previous health file.
 */
import { createHash } from 'node:crypto';
import type { Ledger } from '../../lib/ledger/schema.ts';
import { copyUrl, type ArchiveRecord } from '../storage/archive.ts';
import { USER_AGENT } from '../lib/http.ts';
import type { Fetch } from '../types.ts';
import { HealthFile, summarize, type HealthEntry, type Provider } from './schema.ts';

export interface SourceRef {
  url: string;
  provider: Provider;
  /** The size the ledger records for the file, when it does. */
  expectedSize: number | null;
  /** The ETag of the newest capture from this URL, when there is one. */
  expectedEtag: string | null;
}

const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 20_000;
const PAUSE_MS = 150;
const EVERY_RUN: ReadonlySet<Provider> = new Set(['spotify-signed', 'spotify-current', 'spotify-apt', 'snap']);

export function classify(url: string): Provider {
  const { hostname, pathname, searchParams } = new URL(url);
  if (hostname === 'upgrade.scdn.co') return searchParams.has('fauth') ? 'spotify-signed' : 'other';
  if (hostname === 'download.scdn.co') return 'spotify-current';
  if (hostname === 'repository.spotify.com') return 'spotify-apt';
  if (hostname === 'api.snapcraft.io' && pathname.startsWith('/api/v1/snaps/download/')) return 'snap';
  if (hostname === 'loadspot.amd64fox1.workers.dev') return 'loadspot';
  if (hostname === 'github.com' && pathname.includes('/releases/download/')) return 'github-archive';
  // The archive's own copies in R2, served by its files Worker (worker/): provider "github-archive"
  // is the archive-copy rank, whichever host serves it.
  if (/^spotify-versions-files\.[a-z0-9-]+\.workers\.dev$/.test(hostname) && pathname.startsWith('/sha256/')) return 'github-archive';
  return 'other';
}

/** The `exp` of a signed link's fauth JWT, decoded without verifying it (expiry decides whether to ask). */
export function tokenExpiry(url: string): Date | null {
  const token = new URL(url).searchParams.get('fauth');
  const payload = token?.split('.')[1];
  if (!payload) return null;
  try {
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) ? new Date(exp * 1000) : null;
  } catch {
    return null;
  }
}

/** Whether a weekly-checked link has its slot today. */
export function weeklySlot(url: string, now: Date): boolean {
  return createHash('sha256').update(url).digest().readUInt32BE(0) % 7 === now.getUTCDay();
}

export function dueNow(ref: SourceRef, now: Date, all: boolean): boolean {
  return all || EVERY_RUN.has(ref.provider) || weeklySlot(ref.url, now);
}

/**
 * Every distinct download URL in the ledger with the size and ETag a healthy answer should carry,
 * plus the archive's own copies in R2 when their record (site/data/archive.json) is given.
 */
export function collectSources(ledger: Ledger, archive: ArchiveRecord | null = null): Map<string, SourceRef> {
  const refs = new Map<string, SourceRef>();
  const add = (url: string, size: number | null, etag: string | null) => {
    const existing = refs.get(url);
    if (existing) {
      existing.expectedSize ??= size;
      existing.expectedEtag ??= etag;
      return;
    }
    refs.set(url, { url, provider: classify(url), expectedSize: size, expectedEtag: etag });
  };
  for (const release of ledger.releases) {
    for (const artifact of release.artifacts) {
      for (const source of artifact.listing?.sources ?? []) add(source.url, artifact.listing?.size ?? null, null);
      const captures = [...(artifact.captures ?? [])].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
      for (const capture of captures) {
        add(capture.url, capture.size ?? null, capture.etag ?? null);
        if (capture.archive) add(capture.archive, capture.size ?? null, null);
      }
    }
  }
  if (archive?.base) for (const file of Object.values(archive.files)) add(copyUrl(archive.base, file), file.size, null);
  return refs;
}

/** Drops the query and fragment of a redirect target: signed CDN addresses change with every request. */
function bare(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

const sizeOf = (response: Response): number | null => {
  const range = /\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
  const value = Number(range ? range[1] : response.headers.get('content-length'));
  return range || response.headers.has('content-length') ? (Number.isSafeInteger(value) && value >= 0 ? value : null) : null;
};

export async function checkSource(fetchImpl: Fetch, ref: SourceRef, now: Date): Promise<HealthEntry> {
  const base = { provider: ref.provider, httpStatus: null, size: null, etag: null, lastModified: null, finalUrl: null, ms: null } as const;
  const checkedAt = now.toISOString();
  if (ref.provider === 'spotify-signed') {
    const expires = tokenExpiry(ref.url);
    if (expires && expires.getTime() <= now.getTime()) {
      return { ...base, status: 'expired', checkedAt, detail: `the token expired ${expires.toISOString()}`, expiresAt: expires.toISOString() };
    }
  }
  const started = Date.now();
  let url = ref.url;
  let redirected = false;
  let response: Response | null = null;
  try {
    for (let hop = 0; ; hop++) {
      response = await fetchImpl(url, { method: 'HEAD', redirect: 'manual', headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (response.status === 405 || response.status === 501) {
        response = await fetchImpl(url, { method: 'GET', redirect: 'manual', headers: { 'user-agent': USER_AGENT, range: 'bytes=0-0' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        await response.body?.cancel();
      }
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      if (!location) break;
      const next = new URL(location, url);
      if (next.protocol !== 'https:') return { ...base, status: 'error', httpStatus: response.status, checkedAt, ms: Date.now() - started, detail: `redirect to ${next.protocol} refused` };
      if (hop >= MAX_REDIRECTS) return { ...base, status: 'error', httpStatus: response.status, checkedAt, ms: Date.now() - started, detail: `more than ${MAX_REDIRECTS} redirects` };
      url = next.href;
      redirected = true;
    }
  } catch (error) {
    return { ...base, status: 'error', checkedAt, ms: Date.now() - started, detail: `no answer: ${(error as Error).message}` };
  }
  const answer = response!;
  const size = sizeOf(answer);
  const etag = answer.headers.get('etag');
  const modified = answer.headers.get('last-modified');
  const fields = {
    provider: ref.provider, httpStatus: answer.status, size, etag,
    lastModified: modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null,
    finalUrl: redirected ? bare(url) : url, checkedAt, ms: Date.now() - started,
  };
  if (answer.status === 404 || answer.status === 410) return { ...fields, status: 'gone', detail: `HTTP ${answer.status}` };
  if (answer.status === 401 || answer.status === 403) return { ...fields, status: 'forbidden', detail: `HTTP ${answer.status}` };
  if (answer.status !== 200 && answer.status !== 206) return { ...fields, status: 'error', detail: `HTTP ${answer.status}` };
  if (ref.expectedSize !== null && size !== null && size !== ref.expectedSize) return { ...fields, status: 'drift', detail: `${size} bytes, the ledger records ${ref.expectedSize}` };
  if (ref.expectedEtag && etag && etag !== ref.expectedEtag) return { ...fields, status: 'drift', detail: `ETag ${etag}, the newest capture had ${ref.expectedEtag}` };
  return { ...fields, status: 'ok', detail: `HTTP ${answer.status}, ${size ?? 'unknown'} bytes` };
}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Checks `refs` with at most `limit(host)` requests per host at a time. */
async function checkAll(fetchImpl: Fetch, refs: readonly SourceRef[], now: Date, pauseMs: number): Promise<Map<string, HealthEntry>> {
  const byHost = new Map<string, SourceRef[]>();
  for (const ref of refs) {
    const host = new URL(ref.url).hostname;
    byHost.set(host, [...(byHost.get(host) ?? []), ref]);
  }
  const results = new Map<string, HealthEntry>();
  await Promise.all([...byHost].map(async ([host, queue]) => {
    const limit = host === 'loadspot.amd64fox1.workers.dev' ? 2 : 4;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (next < queue.length) {
        const ref = queue[next++]!;
        results.set(ref.url, await checkSource(fetchImpl, ref, now));
        if (pauseMs > 0) await pause(pauseMs);
      }
    }));
  }));
  return results;
}

export interface HealthOptions {
  now: Date;
  previous: HealthFile | null;
  /** Check every link, ignoring the weekly slots. */
  all?: boolean;
  /** Check only these providers; the others keep their previous results. */
  only?: ReadonlySet<Provider> | null;
  pauseMs?: number;
}

export async function runHealth(fetchImpl: Fetch, refs: ReadonlyMap<string, SourceRef>, options: HealthOptions): Promise<{ file: HealthFile; checked: number }> {
  const { now, previous } = options;
  const today = now.toISOString().slice(0, 10);
  // The workflow runs several times a day: a weekly link already checked today waits for next week.
  const checkedToday = (ref: SourceRef) => !EVERY_RUN.has(ref.provider) && previous?.sources[ref.url]?.checkedAt?.slice(0, 10) === today;
  const due = [...refs.values()].filter(ref => (!options.only || options.only.has(ref.provider)) && dueNow(ref, now, options.all ?? false) && (options.all || !checkedToday(ref)));
  const fresh = await checkAll(fetchImpl, due, now, options.pauseMs ?? PAUSE_MS);
  const sources: Record<string, HealthEntry> = {};
  for (const ref of [...refs.values()].sort((a, b) => a.url.localeCompare(b.url))) {
    const entry = fresh.get(ref.url) ?? previous?.sources[ref.url];
    sources[ref.url] = entry && entry.provider === ref.provider ? entry : {
      provider: ref.provider, status: 'not-checked', httpStatus: null, size: null, etag: null, lastModified: null,
      finalUrl: null, checkedAt: null, ms: null, detail: 'not checked by any run yet',
    };
  }
  const file = HealthFile.parse({ schema: 1, generatedAt: now.toISOString(), sources, summary: summarize(sources) });
  return { file, checked: fresh.size };
}

export interface HealthAlert {
  key: string;
  title: string;
  ok: boolean;
  summary: string;
  details?: string;
}

/**
 * Alerts worth an issue: one of Spotify's current-build URLs not answering, and the LoadSpot mirror
 * failing for most of the links checked in this run. Other dead links are data on the site.
 */
export function healthAlerts(file: HealthFile, now: Date): HealthAlert[] {
  const entries = Object.entries(file.sources);
  const current = entries.filter(([, entry]) => entry.provider === 'spotify-current');
  const down = current.filter(([, entry]) => !['ok', 'drift', 'not-checked'].includes(entry.status));
  const checkedNow = entries.filter(([, entry]) => entry.provider === 'loadspot' && entry.checkedAt === now.toISOString());
  const failing = checkedNow.filter(([, entry]) => entry.status === 'error');
  const mirrorDown = checkedNow.length >= 10 && failing.length / checkedNow.length > 0.5;
  return [
    {
      key: 'health:spotify-current', title: "Spotify's current-build download URLs", ok: down.length === 0,
      summary: down.length ? `${down.length} of ${current.length} current-build URL(s) do not answer` : `${current.length} current-build URL(s) answer`,
      ...(down.length ? { details: down.map(([url, entry]) => `- ${url}: ${entry.status} (${entry.detail})`).join('\n') } : {}),
    },
    {
      key: 'health:loadspot', title: 'The LoadSpot mirror', ok: !mirrorDown,
      summary: mirrorDown ? `${failing.length} of ${checkedNow.length} LoadSpot links checked in this run failed` : `${checkedNow.length - failing.length} of ${checkedNow.length} LoadSpot links checked in this run answered`,
      ...(mirrorDown ? { details: failing.slice(0, 20).map(([url, entry]) => `- ${url}: ${entry.detail}`).join('\n') } : {}),
    },
  ];
}
