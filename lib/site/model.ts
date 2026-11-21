/**
 * The site's view of the archive, computed from three inputs and nothing else:
 *  - the ledger (every release, its artifacts, their listings and captures);
 *  - the link-health file (sensors/health.ts): the last answer of every download link;
 *  - the merged verification report (sensors/verify.ts merge): the checks of the current builds.
 *
 * Pure functions only, so the site (web/), its API and the tests (test/web) read the same thing. A download
 * link is offered only when nothing says it is dead: an expired signed link, a link the health file
 * found gone or refused, or a current-build URL that now serves another build is shown as a record,
 * never as the download.
 */
import type { Artifact, Ledger, Release } from '../ledger/schema.ts';
import { compareVersions } from '../versions.ts';
import { classify, tokenExpiry } from '../../sensors/health/check.ts';
import type { HealthEntry, HealthFile, Provider } from '../../sensors/health/schema.ts';
import type { MergedArtifact, MergedReport } from '../../sensors/verify/report.ts';
import type { VerificationLevel } from '../../sensors/verify/types.ts';

export type Platform = Artifact['platform'];
export type Arch = Artifact['arch'];
export type Format = Artifact['format'];
/** The ui kit's status words: ok, warn, danger, unknown. */
export type SourceState = 'ok' | 'warn' | 'danger' | 'unknown';

export interface SourceView {
  url: string;
  label: string;
  kind: 'official' | 'mirror' | 'archive';
  provider: Provider;
  state: SourceState;
  /** Whether the site offers it as a download. */
  usable: boolean;
  /** One line: what is known about the link. */
  detail: string;
  checkedAt: string | null;
}

export interface VerificationView {
  level: VerificationLevel;
  ok: boolean;
  hosts: string[];
  pass: number;
  fail: number;
  skip: number;
  sha256: string | null;
  generatedAt: string;
  /** False when the verified bytes are not the ones the ledger captured for this artifact. */
  matchesCapture: boolean | null;
}

export interface ArtifactView {
  id: string;
  platform: Platform;
  arch: Arch;
  format: Format;
  size: number | null;
  date: string | null;
  sha256: string | null;
  sha1: string | null;
  sources: SourceView[];
  best: SourceView | null;
  verification: VerificationView | null;
}

export interface ReleaseView {
  product: Release['product'];
  version: string;
  fullVersion: string;
  /** The earliest date any upstream listing or capture gives the build. */
  date: string | null;
  artifacts: ArtifactView[];
  platforms: Platform[];
  /** Any artifact whose latest verification reached the signed level and passed. */
  signed: boolean;
  /** Any artifact offered for download. */
  downloadable: boolean;
}

export const PLATFORM_LABELS: Readonly<Record<Platform, string>> = {
  windows: 'Windows', macos: 'macOS', linux: 'Linux', 'windows-store': 'Microsoft Store', android: 'Android', ios: 'iOS',
};
export const ARCH_LABELS: Readonly<Record<Arch, string>> = { x64: 'x64', arm64: 'ARM64', x86: 'x86 (32-bit)', universal: 'Universal' };
export const FORMAT_LABELS: Readonly<Record<Format, string>> = {
  exe: 'Installer (.exe)', tbz: 'Update archive (.tbz)', dmg: 'Disk image (.dmg)', zip: 'Archive (.zip)', deb: 'Debian package (.deb)',
  snap: 'Snap', msix: 'MSIX', msixbundle: 'MSIX bundle', appx: 'APPX', appxbundle: 'APPX bundle', apk: 'APK', apks: 'Split APKs',
};
export const LEVEL_LABELS: Readonly<Record<VerificationLevel, string>> = {
  signed: 'Signed', 'spotify-digest': "Spotify's hash", 'store-digest': "Store's hash", 'third-party-digest': 'Package manager hash', unverified: 'Not verified',
};

/** Which links to offer first: Spotify's own, then stores, then copies, then the community mirror. */
const PREFERENCE: readonly Provider[] = ['spotify-current', 'spotify-signed', 'spotify-apt', 'snap', 'github-archive', 'loadspot', 'other'];
const STATE_ORDER: readonly SourceState[] = ['ok', 'unknown', 'warn', 'danger'];

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : null);

/** For each current-build URL, the ETag of the newest capture from it: the build it serves, as far as the ledger knows. */
function currentEtags(ledger: Ledger): Map<string, string> {
  const newest = new Map<string, { at: string; etag: string }>();
  for (const release of ledger.releases) {
    for (const artifact of release.artifacts) {
      for (const capture of artifact.captures ?? []) {
        if (!capture.etag || classify(capture.url) !== 'spotify-current') continue;
        const known = newest.get(capture.url);
        if (!known || capture.capturedAt > known.at) newest.set(capture.url, { at: capture.capturedAt, etag: capture.etag });
      }
    }
  }
  return new Map([...newest].map(([url, { etag }]) => [url, etag]));
}

const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

function healthState(entry: HealthEntry | undefined): { state: SourceState; usable: boolean; detail: string; checkedAt: string | null } {
  if (!entry || entry.status === 'not-checked') return { state: 'unknown', usable: true, detail: 'not checked yet', checkedAt: entry?.checkedAt ?? null };
  const when = entry.checkedAt ? ` ${WHEN.format(new Date(entry.checkedAt)).replace(',', '')} UTC` : '';
  switch (entry.status) {
    case 'ok': return { state: 'ok', usable: true, detail: `answered${when}`, checkedAt: entry.checkedAt };
    case 'drift': return { state: 'warn', usable: false, detail: `changed: ${entry.detail}`, checkedAt: entry.checkedAt };
    case 'expired': return { state: 'danger', usable: false, detail: entry.detail, checkedAt: entry.checkedAt };
    default: return { state: 'danger', usable: false, detail: `${entry.status}, ${entry.detail}${when}`, checkedAt: entry.checkedAt };
  }
}

/** Every link of one artifact, best first. */
export function sourceViews(artifact: Artifact, health: HealthFile | null, now: Date, current: ReadonlyMap<string, string>): SourceView[] {
  const views = new Map<string, SourceView>();
  const add = (url: string, label: string, kind: SourceView['kind'], captureEtag: string | null) => {
    if (views.has(url)) return;
    const provider = classify(url);
    const known = healthState(health?.sources[url]);
    let view: SourceView = { url, label, kind, provider, ...known };
    if (provider === 'spotify-current') {
      // A permanent URL serves whatever build is current: it is this build's only while it still has this build's ETag.
      const servedEtag = health?.sources[url]?.etag ?? current.get(url) ?? null;
      const serves = captureEtag !== null && servedEtag !== null && servedEtag === captureEtag && known.state !== 'danger';
      view = serves
        ? { ...view, state: known.state === 'warn' ? 'ok' : known.state, usable: true, detail: known.state === 'unknown' ? 'serves this build' : `serves this build · ${known.detail}` }
        : { ...view, state: 'danger', usable: false, detail: 'now serves a newer build' };
    } else if (provider === 'spotify-signed') {
      const expires = tokenExpiry(url);
      if (expires && expires.getTime() <= now.getTime()) view = { ...view, state: 'danger', usable: false, detail: `signed link expired ${expires.toISOString().slice(0, 10)}` };
      else if (expires) view = { ...view, detail: `signed, valid until ${expires.toISOString().slice(0, 10)}` };
    } else if (provider === 'other' && new URL(url).hostname === 'upgrade.scdn.co') {
      view = { ...view, state: 'danger', usable: false, detail: 'needs a signed token; kept as a record' };
    }
    views.set(url, view);
  };
  const captures = [...(artifact.captures ?? [])].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  for (const capture of captures) {
    add(capture.url, classify(capture.url) === 'spotify-current' ? 'Spotify (current build)' : 'Spotify', 'official', capture.etag ?? null);
    if (capture.archive) add(capture.archive, 'Archive copy', 'archive', null);
  }
  for (const source of artifact.listing?.sources ?? []) add(source.url, source.label, source.kind, null);
  return [...views.values()].sort((a, b) =>
    Number(b.usable) - Number(a.usable)
    || PREFERENCE.indexOf(a.provider) - PREFERENCE.indexOf(b.provider)
    || STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
}

function verificationFor(artifact: Artifact, sha256: string | null, report: MergedReport | null): VerificationView | null {
  const merged: MergedArtifact | undefined = report?.artifacts.find(candidate => candidate.key === artifact.id);
  if (!merged || !report) return null;
  const count = (status: 'pass' | 'fail' | 'skip') => merged.checks.filter(check => check.status === status).length;
  return {
    level: merged.level, ok: merged.ok, hosts: merged.hosts, pass: count('pass'), fail: count('fail'), skip: count('skip'),
    sha256: merged.sha256, generatedAt: report.generatedAt,
    matchesCapture: sha256 && merged.sha256 ? sha256 === merged.sha256 : null,
  };
}

function artifactView(artifact: Artifact, health: HealthFile | null, report: MergedReport | null, now: Date, current: ReadonlyMap<string, string>): ArtifactView {
  const capture = [...(artifact.captures ?? [])].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))[0];
  const sources = sourceViews(artifact, health, now, current);
  const sha256 = capture?.sha256 ?? null;
  return {
    id: artifact.id, platform: artifact.platform, arch: artifact.arch, format: artifact.format,
    size: artifact.listing?.size ?? capture?.size ?? null,
    date: artifact.listing?.date ?? day(capture?.lastModified ?? capture?.capturedAt),
    sha256, sha1: capture?.sha1 ?? null,
    sources, best: sources.find(source => source.usable) ?? null,
    verification: verificationFor(artifact, sha256, report),
  };
}

export function releaseViews(ledger: Ledger, health: HealthFile | null, report: MergedReport | null, now: Date): ReleaseView[] {
  const current = currentEtags(ledger);
  return ledger.releases.map(release => {
    const artifacts = release.artifacts.map(artifact => artifactView(artifact, health, report, now, current));
    const dates = artifacts.map(artifact => artifact.date).filter((date): date is string => date !== null).sort();
    return {
      product: release.product, version: release.version, fullVersion: release.fullVersion,
      date: dates[0] ?? null, artifacts,
      platforms: [...new Set(artifacts.map(artifact => artifact.platform))],
      signed: artifacts.some(artifact => artifact.verification?.ok === true && artifact.verification.level === 'signed'),
      downloadable: artifacts.some(artifact => artifact.best !== null),
    };
  }).sort((a, b) => compareVersions(b.version, a.version) || b.fullVersion.localeCompare(a.fullVersion));
}

export interface ReleaseQuery {
  q?: string;
  platform?: Platform | null;
  arch?: Arch | null;
  sort?: 'newest' | 'oldest';
  signed?: boolean;
  downloadable?: boolean;
}

export function filterReleases(releases: readonly ReleaseView[], query: ReleaseQuery): ReleaseView[] {
  const q = query.q?.trim().toLowerCase();
  const matches = releases.filter(release =>
    (!q || release.fullVersion.toLowerCase().includes(q))
    && (!query.platform || release.artifacts.some(artifact => artifact.platform === query.platform && (!query.arch || artifact.arch === query.arch)))
    && (query.platform || !query.arch || release.artifacts.some(artifact => artifact.arch === query.arch))
    && (!query.signed || release.signed)
    && (!query.downloadable || release.downloadable));
  return query.sort === 'oldest' ? matches.toReversed() : matches;
}

/** A cursor is the index of the next item; anything that is not a valid index starts at 0. */
export function page<T>(items: readonly T[], cursor: string | null | undefined, limit: number): { items: T[]; next: string | null } {
  const start = cursor && /^\d+$/.test(cursor) ? Math.min(Number(cursor), items.length) : 0;
  const end = Math.min(start + limit, items.length);
  return { items: items.slice(start, end), next: end < items.length ? String(end) : null };
}

/** Links that are Spotify's own, a store's, or the archive's own copy: the ones a front page may send everybody to. */
const FIRST_PARTY: ReadonlySet<Provider> = new Set(['spotify-current', 'spotify-signed', 'spotify-apt', 'snap', 'github-archive']);

export interface LatestDownload {
  platform: Platform;
  arch: Arch;
  release: ReleaseView;
  artifact: ArtifactView;
  /** A newer build for which the ledger knows only the community mirror's link (a staged rollout, say). */
  newer: { release: ReleaseView; artifact: ArtifactView } | null;
}

/**
 * The build to feature for each platform and architecture: the newest one with a first-party live
 * link. The community mirror is a fallback, never the front page's default: a platform whose builds
 * only the mirror serves features its newest mirrored build, and a newer mirror-only build is a note.
 */
export function latestDownloads(releases: readonly ReleaseView[]): LatestDownload[] {
  const firstParty = new Map<string, { release: ReleaseView; artifact: ArtifactView }>();
  const any = new Map<string, { release: ReleaseView; artifact: ArtifactView }>();
  for (const release of releases) {
    for (const artifact of release.artifacts) {
      if (!artifact.best) continue;
      const key = `${artifact.platform}/${artifact.arch}`;
      if (!any.has(key)) any.set(key, { release, artifact });
      if (!firstParty.has(key) && FIRST_PARTY.has(artifact.best.provider)) firstParty.set(key, { release, artifact });
    }
  }
  const order: readonly string[] = ['windows/x64', 'windows/arm64', 'macos/arm64', 'macos/x64', 'linux/x64', 'windows/x86'];
  return [...any].map(([key, newest]) => {
    const featured = firstParty.get(key) ?? newest;
    return {
      platform: featured.artifact.platform, arch: featured.artifact.arch, release: featured.release, artifact: featured.artifact,
      newer: featured.release === newest.release ? null : newest,
    };
  }).sort((a, b) => order.indexOf(`${a.platform}/${a.arch}`) - order.indexOf(`${b.platform}/${b.arch}`));
}

export function findRelease(releases: readonly ReleaseView[], product: string, version: string): ReleaseView | null {
  return releases.find(release => release.product === product && (release.version === version || release.fullVersion === version)) ?? null;
}

/** The release before and after, in version order. */
export function neighbours(releases: readonly ReleaseView[], release: ReleaseView): { newer: ReleaseView | null; older: ReleaseView | null } {
  const index = releases.indexOf(release);
  return { newer: index > 0 ? releases[index - 1]! : null, older: index >= 0 && index < releases.length - 1 ? releases[index + 1]! : null };
}

/** The API v2 shape of a release: stable field names, links only where they are offered. */
export function releaseJson(release: ReleaseView) {
  return {
    product: release.product, version: release.version, fullVersion: release.fullVersion, date: release.date,
    signed: release.signed,
    artifacts: release.artifacts.map(artifact => ({
      id: artifact.id, platform: artifact.platform, arch: artifact.arch, format: artifact.format,
      size: artifact.size, date: artifact.date, sha256: artifact.sha256,
      download: artifact.best ? { url: artifact.best.url, label: artifact.best.label, kind: artifact.best.kind } : null,
      sources: artifact.sources.map(source => ({ url: source.url, label: source.label, kind: source.kind, provider: source.provider, state: source.state, usable: source.usable, detail: source.detail, checkedAt: source.checkedAt })),
      verification: artifact.verification,
    })),
  };
}
