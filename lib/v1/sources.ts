/**
 * Host and path allowlist for download links, ported from the v1 catalog (site/src/lib/catalog.mjs)
 * with its behaviour unchanged, because the v1 feeds that outside apps read are generated through it.
 * A URL that does not have one of these exact shapes is not a source.
 */
import { FULL_VERSION } from '../versions.ts';

export type Platform = 'windows' | 'macos' | 'linux' | 'windows-store' | 'android' | 'ios';
export type SourceKind = 'official' | 'archive' | 'mirror';

export interface V1Source {
  url: string;
  kind: SourceKind;
  label: string;
  etag?: string | null | undefined;
  expired?: boolean;
  note?: string;
  until?: string | undefined;
}

export const REPOSITORY = 'RobyRew/spotify-versions-history';
// Archive copies were attached to the installer repository before this catalog moved here, so
// links already recorded under that name stay resolvable.
export const ARCHIVE_REPOSITORIES = [REPOSITORY, 'RobyRew/BlockTheSpot-Installer'];
export const PERMANENT: Readonly<Record<string, string>> = { x64: '/SpotifyFullSetupX64.exe', arm64: '/SpotifyFullSetupARM64.exe', x86: '/SpotifyFullSetup.exe' };
/** Host of the never-deployed v1 own mirror; v1 still accepts its path shape. */
export const ARCHIVE_HOST = 'dl.spotify-versions-history.robyrew.com';
export const MIRROR_HOST = 'loadspot.amd64fox1.workers.dev';
const linuxDeb: Readonly<Record<string, string>> = { x64: 'amd64', arm64: 'arm64', x86: 'i386' };

type Target = readonly [group: string, key: string, platform: Platform, architecture: string, directory: string, format: string];
export const TARGETS: readonly Target[] = [
  ['win', 'x64', 'windows', 'x64', 'win32-x86_64', 'exe'],
  ['win', 'x86', 'windows', 'x86', 'win32-x86', 'exe'],
  ['win', 'arm64', 'windows', 'arm64', 'win32-arm64', 'exe'],
  ['mac', 'intel', 'macos', 'x64', 'osx-x86_64', 'tbz'],
  ['mac', 'arm64', 'macos', 'arm64', 'osx-arm64', 'tbz'],
  ['linux', 'amd64', 'linux', 'x64', '', 'deb'],
  ['linux', 'arm64', 'linux', 'arm64', '', 'deb'],
  ['linux', 'i386', 'linux', 'x86', '', 'deb'],
];

export function sourceFor(raw: unknown, fullVersion: string, platform: string, architecture: string): V1Source | null {
  if (!FULL_VERSION.test(fullVersion)) return null;
  let url: URL;
  try { url = new URL(raw as string); } catch { return null; }
  // Spotify's versioned links carry a signed ?fauth= token; no other query string is accepted anywhere.
  const signed = url.hostname === 'upgrade.scdn.co' && /^\?fauth=[A-Za-z0-9._~-]+$/.test(url.search);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.search && !signed) || url.hash) return null;
  const target = TARGETS.find(([, , p, a]) => p === platform && a === architecture);
  if (!target) return null;
  const [, , , , directory, format] = target;
  const stem = platform === 'windows' ? `spotify_installer-${fullVersion}` : `spotify-autoupdate-${fullVersion}`;
  if (url.hostname === 'upgrade.scdn.co' && platform !== 'linux') {
    const prefix = `/upgrade/client/${directory}/${stem}-`;
    if (url.pathname.startsWith(prefix) && new RegExp(`^\\d+\\.${format}$`).test(url.pathname.slice(prefix.length)))
      return { url: url.href, kind: 'official', label: 'Spotify CDN' };
  }
  const deb = linuxDeb[architecture];
  if (url.hostname === 'repository.spotify.com' && platform === 'linux' && deb &&
      url.pathname === `/pool/non-free/s/spotify-client/spotify-client_${fullVersion}_${deb}.deb`)
    return { url: url.href, kind: 'official', label: 'Spotify repository' };
  // Spotify's permanent full installers always serve the current build; applyOfficial attaches
  // one only to the build whose ETag the watcher last saw there.
  if (url.hostname === 'download.scdn.co' && platform === 'windows' && url.pathname === PERMANENT[architecture])
    return { url: url.href, kind: 'official', label: 'Spotify (current build)' };
  if (url.hostname === 'github.com' && platform === 'windows' && ARCHIVE_REPOSITORIES.some(repository =>
      new RegExp(`^/${repository}/releases/download/[A-Za-z0-9._-]+/spotify_installer-${fullVersion.replace(/\./g, '\\.')}-${architecture}\\.exe$`).test(url.pathname)))
    return { url: url.href, kind: 'archive', label: 'GitHub archive' };
  const suffix = platform === 'macos' && architecture === 'x64' ? 'x86_64' : architecture;
  const file = platform === 'linux' && deb
    ? `spotify-client_${fullVersion}_${deb}.deb`
    : `${stem}-${suffix}.${format}`;
  if (url.hostname === MIRROR_HOST && url.pathname === `/download/${file}`)
    return { url: url.href, kind: 'mirror', label: 'LoadSpot mirror' };
  // Own mirror: /sha256/<64 hex>/<stable filename>. Any other path on that host is rejected.
  const parts = url.pathname.split('/');
  if (url.hostname === ARCHIVE_HOST && parts.length === 4 && parts[1] === 'sha256' && /^[0-9a-f]{64}$/.test(parts[2] ?? '') && parts[3] === file)
    return { url: url.href, kind: 'archive', label: 'Archive' };
  return null;
}
