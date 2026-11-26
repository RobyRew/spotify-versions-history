/**
 * Version history of Spotify for iPhone and iPad and for Android, read from the stores' public
 * listings (no account): iOS and Android are recorded as metadata only, because neither store's
 * build can be downloaded and checked without one (docs/IOS.md, docs/ANDROID_UPDATE.md).
 *
 * - iOS: the App Store page's "Version History" (the newest 25 versions, each with its release
 *   time) plus the iTunes lookup for the current version's minimum iOS and size.
 * - Android: Google Play does not publish Spotify's version (its version field is empty: the app
 *   ships per device). The listing does give the time of each update, and its reviews name the app
 *   version each reviewer ran; the newest of those is kept as `reportedVersion`, never as the
 *   official version.
 *
 * site/data/mobile-history.json keeps every version and update ever read; nothing is dropped when it
 * falls off a store's list.
 */

export const APP_STORE_PAGE = 'https://apps.apple.com/us/app/spotify-music-and-podcasts/id324684580';
export const ITUNES_LOOKUP = 'https://itunes.apple.com/lookup?id=324684580&country=us';
export const PLAY_PAGE = 'https://play.google.com/store/apps/details?id=com.spotify.music&hl=en&gl=US';
const IOS_TRACK_ID = 324684580;
const IOS_BUNDLE_ID = 'com.spotify.client';

export interface IosVersion {
  version: string;
  releasedAt: string;
  firstSeen: string;
  minimumOsVersion?: string | null;
  sizeBytes?: number | null;
}

export interface AndroidUpdate {
  updatedAt: string;
  firstSeen: string;
  /** The newest app version Play's reviews named when the update was read; not an official version. */
  reportedVersion: string | null;
}

export interface MobileHistory {
  schemaVersion: 1;
  /** When the content last changed (a run that reads nothing new leaves the file alone). */
  changedAt: string;
  ios: { listing: string; versions: IosVersion[] };
  android: { listing: string; updates: AndroidUpdate[] };
}

const VERSION = /^\d{1,4}(\.\d{1,6}){1,3}$/;

/** Numeric order of dotted versions, newest first when used as `b, a`. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

/** The App Store page's version history: [{version, releasedAt}], newest first. */
export function appStoreHistory(html: string): { version: string; releasedAt: string }[] {
  const found = new Map<string, string>();
  for (const match of html.matchAll(/"primarySubtitle":"(\d[\d.]*)","secondarySubtitle":"([^"]{6,80})"/g)) {
    const [, version, when] = match;
    const time = Date.parse(when!.replace(/\s*\(.*\)$/, ''));
    if (!VERSION.test(version!) || !Number.isFinite(time) || found.has(version!)) continue;
    found.set(version!, iso(time));
  }
  return [...found].map(([version, releasedAt]) => ({ version, releasedAt })).sort((a, b) => compareVersions(b.version, a.version));
}

/** The current version's details from the iTunes lookup, or null. */
export function itunesCurrent(payload: unknown): { version: string; releasedAt: string | null; minimumOsVersion: string | null; sizeBytes: number | null } | null {
  const results = (payload as { results?: Record<string, unknown>[] } | null)?.results ?? [];
  const app = results.find(row => row.trackId === IOS_TRACK_ID && row.bundleId === IOS_BUNDLE_ID);
  if (!app || typeof app.version !== 'string' || !VERSION.test(app.version)) return null;
  const size = Number(app.fileSizeBytes);
  const released = typeof app.currentVersionReleaseDate === 'string' ? Date.parse(app.currentVersionReleaseDate) : NaN;
  return {
    version: app.version,
    releasedAt: Number.isFinite(released) ? iso(released) : null,
    minimumOsVersion: typeof app.minimumOsVersion === 'string' ? app.minimumOsVersion : null,
    sizeBytes: Number.isSafeInteger(size) && size > 0 ? size : null,
  };
}

function dataBlocks(html: string): Map<string, unknown> {
  const blocks = new Map<string, unknown>();
  for (const match of html.matchAll(/AF_initDataCallback\(\{key: '(ds:\d+)'.*?data:([\s\S]*?), sideChannel: \{\}\}\);/g)) {
    try {
      blocks.set(match[1]!, JSON.parse(match[2]!));
    } catch {
      // A block that is not JSON is skipped.
    }
  }
  return blocks;
}

function versionsIn(node: unknown, out: string[]): void {
  if (typeof node === 'string') {
    if (/^\d{1,3}\.\d{1,4}\.\d{1,5}\.\d{1,6}$/.test(node)) out.push(node);
  } else if (Array.isArray(node)) {
    for (const item of node) versionsIn(item, out);
  }
}

/** Google Play's last update time and the newest version its reviews name, or null without an update time. */
export function playReading(html: string): { updatedAt: string; reportedVersion: string | null } | null {
  const blocks = dataBlocks(html);
  // ds:5 holds the app's details; [1][2][145][0] is ["Nov 24, 2026", [seconds, nanos]].
  const at = (node: unknown, ...path: number[]): unknown => path.reduce<unknown>((value, key) => (Array.isArray(value) ? value[key] : undefined), node);
  const seconds = Number(at(blocks.get('ds:5'), 1, 2, 145, 0, 1, 0));
  if (!Number.isFinite(seconds) || seconds < 1_000_000_000) return null;
  const updated = seconds * 1000;
  const versions: string[] = [];
  for (const [key, value] of blocks) if (key !== 'ds:5') versionsIn(value, versions);
  const reportedVersion = versions.sort(compareVersions).at(-1) ?? null;
  return { updatedAt: iso(updated), reportedVersion };
}

export interface MobileReadings {
  appStore: { version: string; releasedAt: string }[];
  itunes: ReturnType<typeof itunesCurrent>;
  play: ReturnType<typeof playReading>;
}

/** Adds what the readings show to the history; returns the same object when nothing is new. */
export function mergeMobileHistory(previous: MobileHistory | null, readings: MobileReadings, now: Date): MobileHistory {
  const stamp = iso(now.getTime());
  const history: MobileHistory = structuredClone(previous ?? {
    schemaVersion: 1, changedAt: stamp,
    ios: { listing: APP_STORE_PAGE, versions: [] },
    android: { listing: 'https://play.google.com/store/apps/details?id=com.spotify.music', updates: [] },
  });
  let changed = previous === null;
  const iosByVersion = new Map(history.ios.versions.map(entry => [entry.version, entry]));
  const seen = [...readings.appStore];
  if (readings.itunes?.releasedAt && !seen.some(entry => entry.version === readings.itunes!.version)) seen.push({ version: readings.itunes.version, releasedAt: readings.itunes.releasedAt });
  for (const { version, releasedAt } of seen) {
    if (!iosByVersion.has(version)) {
      iosByVersion.set(version, { version, releasedAt, firstSeen: stamp });
      changed = true;
    }
  }
  if (readings.itunes) {
    const entry = iosByVersion.get(readings.itunes.version);
    if (entry) {
      for (const key of ['minimumOsVersion', 'sizeBytes'] as const) {
        const value = readings.itunes[key];
        if (value !== null && entry[key] !== value) {
          (entry as unknown as Record<string, unknown>)[key] = value;
          changed = true;
        }
      }
    }
  }
  history.ios.versions = [...iosByVersion.values()].sort((a, b) => compareVersions(b.version, a.version));
  if (readings.play && !history.android.updates.some(update => update.updatedAt === readings.play!.updatedAt)) {
    history.android.updates.unshift({ updatedAt: readings.play.updatedAt, firstSeen: stamp, reportedVersion: readings.play.reportedVersion });
    history.android.updates.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    changed = true;
  }
  if (!changed) return previous!;
  history.changedAt = stamp;
  return history;
}
