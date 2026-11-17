/**
 * The v1 catalog model and its overlay rules, ported from site/src/lib/catalog.mjs with behaviour
 * unchanged. BlockTheSpot-Installer reads api/v1/windows-x64.json and Make It Play reads
 * api/v1/catalog.json; both are produced by applyOfficial + windowsFeed below, and
 * test/v1-golden.test.ts compares their output byte for byte with the pre-v2 generator's.
 */
import { compareVersions, FULL_VERSION } from '../versions.ts';
import { sourceFor, type Platform, type V1Source } from './sources.ts';

export const TESTED_VERSION = '1.2.93.667.g7b5cc0ce';

export interface V1Entry {
  id: string;
  version: string;
  fullVersion: string;
  platform: Platform;
  architecture: string;
  format: string;
  date: string | null;
  size: number | null;
  tested: boolean;
  sources: V1Source[];
  sha256?: string;
}

export interface UpdateServiceSighting {
  httpPrefix?: string;
  binaryHash?: string | null;
  targetVersion?: number;
  seenAt?: string;
  signedUrl?: string;
  signedUntil?: string;
}

/** One build recorded by the release watcher (official.json `builds[]`). */
export interface LegacyBuild {
  fullVersion: string;
  platform: Platform;
  architecture: string;
  sha256: string;
  sha1?: string;
  size?: number;
  lastModified?: string | null;
  capturedAt?: string;
  url?: string;
  etag?: string | null;
  sensors?: string[];
  format?: string;
  verified?: string;
  conflict?: string;
  updateService?: UpdateServiceSighting;
  archive?: string;
  archivedFrom?: string;
}

export interface WatchedUrl {
  etag?: string | null;
  size?: number | null;
  lastModified?: string | null;
  checkedAt?: string;
  changedAt?: string;
}

export interface LegacyOfficial {
  schemaVersion?: number;
  watched?: Record<string, WatchedUrl>;
  updateService?: Record<string, unknown>;
  builds: LegacyBuild[];
}

export interface LegacyCatalog {
  schemaVersion: number;
  updatedAt: string;
  testedVersion: string;
  upstream: string[];
  entries: V1Entry[];
}

const PLATFORM_ORDER = ['windows', 'macos', 'linux', 'windows-store', 'android', 'ios'];
const ARCH_ORDER = ['x64', 'arm64', 'x86'];

/** Catalog order: newest version first, then platform, architecture and id. */
export function compareEntries(a: V1Entry, b: V1Entry): number {
  return compareVersions(b.version, a.version) ||
    PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) ||
    ARCH_ORDER.indexOf(a.architecture) - ARCH_ORDER.indexOf(b.architecture) || a.id.localeCompare(b.id);
}

export function mergeCatalogs(...catalogs: V1Entry[][]): V1Entry[] {
  const merged = new Map<string, V1Entry>();
  for (const entry of catalogs.flat()) {
    const previous = merged.get(entry.id);
    const sources = new Map([...(previous?.sources ?? []), ...entry.sources].map(source => [source.url, source] as const));
    const sha256 = entry.sha256 ?? previous?.sha256;
    merged.set(entry.id, { ...entry, date: entry.date ?? previous?.date ?? null, size: entry.size ?? previous?.size ?? null,
      ...(sha256 ? { sha256 } : {}),
      sources: [...sources.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url)) });
  }
  return [...merged.values()].sort(compareEntries);
}

// Spotify's own links first: the permanent full installer while it serves the build, its signed
// versioned link while the token lasts, the apt repository; then the CI archive copy, then the
// maintained LoadSpot mirror. Expired official links stay listed, after everything that downloads.
const PREFERENCE = ['Spotify (current build)', 'Spotify CDN', 'Spotify repository', 'Archive', 'GitHub archive', 'LoadSpot mirror'];

function nextRelease(official: LegacyOfficial, build: LegacyBuild): string | null {
  const later = official.builds
    .filter(b => b.platform === build.platform && b.architecture === build.architecture && b.etag && (b.lastModified as string) > (build.lastModified as string))
    .toSorted((a, b) => (a.lastModified as string).localeCompare(b.lastModified as string))[0];
  return later?.lastModified?.slice(0, 10) ?? null;
}

/** A versioned Spotify link downloads only with its signed token; the bare path is kept as the build's record. */
export function isExpired(source: V1Source): boolean {
  return Boolean(source.expired) || (source.label === 'Spotify CDN' && !/\?fauth=/.test(source.url));
}

export function orderedSources(entry: Pick<V1Entry, 'sources'>, kind = 'all'): V1Source[] {
  return entry.sources.filter(source => kind === 'all' || source.kind === kind)
    .toSorted((a, b) => Number(isExpired(a)) - Number(isExpired(b)) || PREFERENCE.indexOf(a.label) - PREFERENCE.indexOf(b.label));
}

/** Best source first; an entry whose only sources have expired still lists, so the record stays visible. */
export function selectSource(entry: Pick<V1Entry, 'sources'>, kind = 'all'): V1Source | undefined {
  return orderedSources(entry, kind)[0];
}

/**
 * Overlays the release watcher's observations on the catalog: the SHA-256 CI computed from Spotify's
 * own file, the CI archive copy when one exists, and, for the build currently behind a permanent URL,
 * that URL with its ETag.
 */
export function applyOfficial(entries: V1Entry[], official: LegacyOfficial | null | undefined, now = Date.now()): V1Entry[] {
  if (!official?.builds?.length) return entries;
  const current = new Set(Object.values(official.watched ?? {}).map(watched => watched.etag));
  const observed: V1Entry[] = [];
  for (const build of official.builds) {
    if (!FULL_VERSION.test(build.fullVersion ?? '') || !/^[0-9a-f]{64}$/.test(build.sha256 ?? '')) continue;
    const sources: V1Source[] = [];
    const permanent = sourceFor(build.url, build.fullVersion, build.platform, build.architecture)?.label === 'Spotify (current build)';
    if (current.has(build.etag) && permanent)
      sources.push({ url: build.url as string, kind: 'official', label: 'Spotify (current build)', etag: build.etag });
    else if (build.etag && permanent)
      // Spotify's full installer served this build until the next release; the address now serves a newer one.
      sources.push({ url: build.url as string, kind: 'official', label: 'Spotify (current build)', expired: true, note: `Served this build until ${nextRelease(official, build) ?? 'the next release'}` });
    // The update service's signed link is Spotify's direct download for 30 days; afterwards the bare
    // versioned path stays on record, visibly expired, like the historical CDN links.
    const service = build.updateService ?? {};
    const live = service.signedUrl && service.signedUntil && Date.parse(service.signedUntil) > now
      ? sourceFor(service.signedUrl, build.fullVersion, build.platform, build.architecture) : null;
    if (live?.label === 'Spotify CDN') sources.push({ ...live, until: service.signedUntil });
    else if (service.httpPrefix && sourceFor(service.httpPrefix, build.fullVersion, build.platform, build.architecture)?.label === 'Spotify CDN')
      sources.push({ url: service.httpPrefix, kind: 'official', label: 'Spotify CDN', expired: true });
    const archive = build.archive ? sourceFor(build.archive, build.fullVersion, build.platform, build.architecture) : null;
    if (archive?.kind === 'archive') sources.push(archive);
    observed.push({
      id: `${build.fullVersion}-${build.platform}-${build.architecture}`,
      version: build.fullVersion.split('.').slice(0, 4).join('.'), fullVersion: build.fullVersion,
      platform: build.platform, architecture: build.architecture,
      format: build.format ?? (build.platform === 'macos' ? 'tbz' : build.platform === 'linux' ? 'deb' : 'exe'),
      date: typeof build.lastModified === 'string' ? build.lastModified.slice(0, 10) : null,
      size: Number.isSafeInteger(build.size) && (build.size as number) > 0 ? (build.size as number) : null,
      tested: build.platform === 'windows' && build.architecture === 'x64' && build.fullVersion.toLowerCase() === TESTED_VERSION,
      sha256: build.sha256, sources,
    });
  }
  return mergeCatalogs(entries, observed);
}

export interface WindowsFeedBuild {
  url: string;
  official?: string;
  etag?: string | null | undefined;
  archive?: string;
  sha256?: string;
  date?: string;
  size: number;
}
export interface WindowsFeedEntry {
  fullversion: string;
  win: { x64: WindowsFeedBuild };
}

/**
 * The installer feed: every Windows x64 build. `url` keeps the LoadSpot mirror (the stable link) so
 * older parsers still work; `official` is Spotify's own link, `archive` the CI copy, `sha256` the hash
 * CI took from Spotify's file.
 */
export function windowsFeed(entries: V1Entry[]): Record<string, WindowsFeedEntry> {
  const rows: Array<[string, WindowsFeedEntry]> = [];
  for (const entry of entries) {
    if (entry.platform !== 'windows' || entry.architecture !== 'x64') continue;
    const find = (label: string) => entry.sources.find(source => source.label === label && !isExpired(source));
    const current = find('Spotify (current build)');
    // Spotify first: the permanent URL while current, the signed link while valid, else the bare path the app tries and falls back from.
    const official = current ?? find('Spotify CDN') ?? entry.sources.find(source => source.label === 'Spotify CDN');
    const mirror = find('LoadSpot mirror')?.url;
    const archive = find('GitHub archive')?.url;
    const url = mirror ?? archive ?? official?.url;
    // A build with no link at all has nothing to offer the installer.
    if (!url) continue;
    rows.push([entry.version, { fullversion: entry.fullVersion, win: { x64: {
      url,
      ...(official && (mirror || archive) ? { official: official.url } : {}),
      ...(current ? { etag: current.etag } : {}),
      ...(archive ? { archive } : {}),
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(entry.date ? { date: entry.date.split('-').reverse().join('.') } : {}), size: entry.size ?? 0,
    } } }]);
  }
  return Object.fromEntries(rows);
}
