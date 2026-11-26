/**
 * One status card per platform for the probes page: what is watched, when the workflow that reads it
 * last ran, how the current builds' signature checks came out and whether the download links answer.
 * Pure: the website passes in what it loaded (web/src/lib/data.ts).
 */
import type { MobileHistory } from '../../sensors/mobile.ts';
import type { MergedArtifact } from '../../sensors/verify/report.ts';
import { compareVersions } from '../versions.ts';
import type { ReleaseView } from './model.ts';

export type ProbeState = 'ok' | 'warn' | 'danger' | 'unknown';
export type ProbePlatform = 'windows' | 'macos' | 'linux' | 'windows-store' | 'ios' | 'android';

export interface ProbeLine {
  label: string;
  value: string;
  state: ProbeState;
  href?: string;
}

export interface PlatformProbe {
  id: ProbePlatform;
  name: string;
  newest: { version: string | null; date: string | null; note?: string } | null;
  state: ProbeState;
  lines: ProbeLine[];
  /** One sentence on what the archive can and cannot do for this platform. */
  note?: string;
}

export interface ProbeRun {
  conclusion: string | null;
  startedAt: string;
  url: string;
}

export interface ProbeInput {
  now: Date;
  releases: readonly ReleaseView[];
  verification: { generatedAt: string; artifacts: readonly MergedArtifact[] } | null;
  health: { generatedAt: string; summary: Record<string, Record<string, number>> } | null;
  /** The release watcher's watched URLs (official.json `watched`). */
  watched: Record<string, { lastModified?: string | null; changedAt?: string | null }>;
  mobile: { ios?: { version?: string; releaseDate?: string } | null; windowsStore?: { lastUpdate?: string | null } | null } | null;
  mobileHistory: MobileHistory | null;
  /** Newest finished runs by workflow file name. */
  runs: Record<string, ProbeRun>;
}

const HOUR = 3_600_000;
const WORST: readonly ProbeState[] = ['danger', 'warn', 'ok'];

export function worstState(states: readonly ProbeState[]): ProbeState {
  return WORST.find(state => states.includes(state)) ?? 'unknown';
}

/** A finished workflow run as a line: failed runs are danger, runs older than `staleAfter` hours warn. */
export function runLine(label: string, cadence: string, run: ProbeRun | undefined, staleAfterHours: number, now: Date, words: (iso: string) => string): ProbeLine {
  if (!run) return { label, value: `${cadence}; no run seen yet`, state: 'unknown' };
  const age = now.getTime() - Date.parse(run.startedAt);
  const failed = run.conclusion !== 'success';
  const stale = age > staleAfterHours * HOUR;
  return {
    label,
    value: `${cadence}; last run ${words(run.startedAt)}${failed ? `, ${run.conclusion ?? 'unfinished'}` : ''}${stale && !failed ? ' (late)' : ''}`,
    state: failed ? 'danger' : stale ? 'warn' : 'ok',
    href: run.url,
  };
}

function verificationLine(input: ProbeInput, sensors: readonly string[], words: (iso: string) => string): ProbeLine {
  const report = input.verification;
  if (!report) return { label: 'Signature check', value: 'No report yet', state: 'unknown' };
  const mine = report.artifacts.filter(artifact => sensors.includes(artifact.sensor));
  if (mine.length === 0) return { label: 'Signature check', value: 'Not in the daily check', state: 'unknown' };
  const ok = mine.filter(artifact => artifact.ok).length;
  const signed = mine.filter(artifact => artifact.ok && artifact.level === 'signed').length;
  const stale = input.now.getTime() - Date.parse(report.generatedAt) > 36 * HOUR;
  return {
    label: 'Signature check',
    value: `${signed} of ${mine.length} current files signed${ok < mine.length ? `, ${mine.length - ok} failing` : ''}; ${words(report.generatedAt)}`,
    state: ok < mine.length ? 'danger' : stale ? 'warn' : 'ok',
    href: '#verification',
  };
}

function linksLine(input: ProbeInput, providers: readonly string[], label: string): ProbeLine {
  const summary = input.health?.summary;
  if (!summary) return { label: 'Download links', value: 'No link check yet', state: 'unknown' };
  let ok = 0;
  let checked = 0;
  for (const provider of providers) {
    for (const [status, count] of Object.entries(summary[provider] ?? {})) {
      if (status === 'not-checked') continue;
      checked += count;
      if (status === 'ok') ok += count;
    }
  }
  if (checked === 0) return { label: 'Download links', value: `${label}: none checked yet`, state: 'unknown' };
  const share = ok / checked;
  return { label: 'Download links', value: `${label}: ${ok} of ${checked} answer`, state: share === 1 ? 'ok' : share >= 0.5 ? 'warn' : 'danger', href: '#links' };
}

function newestDesktop(releases: readonly ReleaseView[], platform: 'windows' | 'macos' | 'linux') {
  const release = releases.find(item => item.artifacts.some(artifact => artifact.platform === platform && artifact.best));
  return release ? { version: release.version, date: release.date } : null;
}

function latestChange(watched: ProbeInput['watched'], prefix: string): string | null {
  const times = Object.entries(watched).filter(([key]) => key.startsWith(prefix)).map(([, value]) => value.lastModified ?? value.changedAt ?? null).filter((value): value is string => Boolean(value));
  return times.sort().at(-1) ?? null;
}

export function platformProbes(input: ProbeInput, words: (iso: string) => string): PlatformProbe[] {
  const watcher = input.runs['watch-spotify.yml'];
  const refresh = input.runs['pages.yml'];
  const watcherLine = runLine('Release watcher', 'Every 30 minutes', watcher, 2, input.now, words);
  const refreshLine = (label: string) => runLine(label, 'Every 6 hours', refresh, 8, input.now, words);
  const desktopLinks = linksLine(input, ['spotify-current', 'spotify-signed', 'loadspot'], 'Spotify and the mirror');
  const cards: PlatformProbe[] = [];

  for (const [id, name, prefix, sensors] of [['windows', 'Windows', 'windows-', ['windows']], ['macos', 'macOS', 'macos-', ['macos']]] as const) {
    const changed = latestChange(input.watched, prefix);
    const lines = [
      watcherLine,
      { label: 'Spotify’s current installers', value: changed ? `last changed ${words(changed)}` : 'no change recorded', state: changed ? 'ok' : 'unknown' } as ProbeLine,
      verificationLine(input, sensors, words),
      desktopLinks,
    ];
    cards.push({ id, name, newest: newestDesktop(input.releases, id), state: worstState(lines.map(line => line.state)), lines });
  }

  const linuxLines = [refreshLine('apt and Snap Store refresh'), verificationLine(input, ['apt', 'snap'], words), linksLine(input, ['spotify-apt', 'snap'], 'apt pool and Snap Store')];
  cards.push({ id: 'linux', name: 'Linux', newest: newestDesktop(input.releases, 'linux'), state: worstState(linuxLines.map(line => line.state)), lines: linuxLines });

  const storeUpdate = input.mobile?.windowsStore?.lastUpdate ?? null;
  const storeArtifacts = input.verification?.artifacts.filter(artifact => artifact.sensor === 'store') ?? [];
  const storeNewest = storeArtifacts.map(artifact => artifact.version).sort(compareVersions).at(-1) ?? null;
  const storeLines = [
    refreshLine('Store listing refresh'),
    { label: 'Store listing', value: storeUpdate ? `last updated ${words(storeUpdate)}` : 'no update recorded', state: storeUpdate ? 'ok' : 'unknown' } as ProbeLine,
    verificationLine(input, ['store'], words),
  ];
  cards.push({ id: 'windows-store', name: 'Microsoft Store', newest: storeNewest ? { version: storeNewest, date: storeUpdate } : null, state: worstState(storeLines.map(line => line.state)), lines: storeLines });

  const ios = input.mobileHistory?.ios.versions ?? [];
  const iosNewest = ios[0] ?? null;
  const iosLines = [
    refreshLine('App Store refresh'),
    { label: 'Versions recorded', value: ios.length ? `${ios.length}, back to ${ios.at(-1)!.version}` : 'none yet', state: ios.length ? 'ok' : 'unknown', href: '/mobile#ios' } as ProbeLine,
    iosNewest?.minimumOsVersion ? { label: 'Requires', value: `iOS ${iosNewest.minimumOsVersion} or later`, state: 'ok' } as ProbeLine : null,
  ].filter((line): line is ProbeLine => line !== null);
  cards.push({
    id: 'ios', name: 'iPhone and iPad',
    newest: iosNewest ? { version: iosNewest.version, date: iosNewest.releasedAt } : input.mobile?.ios?.version ? { version: input.mobile.ios.version, date: input.mobile.ios.releaseDate ?? null } : null,
    state: worstState(iosLines.map(line => line.state)), lines: iosLines,
    note: 'Version history only: an App Store build is encrypted for the account that downloaded it.',
  });

  const android = input.mobileHistory?.android.updates ?? [];
  const androidNewest = android[0] ?? null;
  const androidLines = [
    refreshLine('Google Play refresh'),
    { label: 'Updates recorded', value: android.length ? `${android.length}` : 'none yet', state: android.length ? 'ok' : 'unknown', href: '/mobile#android' } as ProbeLine,
    androidNewest?.reportedVersion ? { label: 'Reported by reviewers', value: androidNewest.reportedVersion, state: 'ok' } as ProbeLine : null,
  ].filter((line): line is ProbeLine => line !== null);
  cards.push({
    id: 'android', name: 'Android',
    newest: androidNewest ? { version: null, date: androidNewest.updatedAt, note: 'Updated' } : null,
    state: worstState(androidLines.map(line => line.state)), lines: androidLines,
    note: 'Update dates only: Google Play does not publish Spotify’s version, and its builds download only with a Google account.',
  });
  return cards;
}
