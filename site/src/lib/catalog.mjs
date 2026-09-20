export const TESTED_VERSION = '1.2.93.667.g7b5cc0ce';
export const LIVE_CATALOG = 'https://raw.githubusercontent.com/LoaderSpot/table/main/table/versions.json';
export const LEGACY_CATALOG = 'https://raw.githubusercontent.com/LoaderSpot/LoaderSpot/main/versions.json';
export const LINUX_PACKAGES = 'https://repository.spotify.com/dists/stable/non-free/binary-amd64/Packages';
export const REPOSITORY = 'RobyRew/spotify-versions-history';
// Archive copies were attached to the installer repository before this catalog moved here, so
// links already recorded under that name stay resolvable.
export const ARCHIVE_REPOSITORIES = [REPOSITORY, 'RobyRew/BlockTheSpot-Installer'];
export const PERMANENT = { x64: '/SpotifyFullSetupX64.exe', arm64: '/SpotifyFullSetupARM64.exe', x86: '/SpotifyFullSetup.exe' };
const versionPattern = /^1\.\d{1,5}\.\d{1,5}\.\d{1,8}\.g[0-9a-f]{8,40}$/i;
const targets = [
  ['win', 'x64', 'windows', 'x64', 'win32-x86_64', 'exe'],
  ['win', 'x86', 'windows', 'x86', 'win32-x86', 'exe'],
  ['win', 'arm64', 'windows', 'arm64', 'win32-arm64', 'exe'],
  ['mac', 'intel', 'macos', 'x64', 'osx-x86_64', 'tbz'],
  ['mac', 'arm64', 'macos', 'arm64', 'osx-arm64', 'tbz'],
  ['linux', 'amd64', 'linux', 'x64', '', 'deb'],
];

export function compareVersions(a, b) {
  const left = a.split('.').slice(0, 4).map(Number);
  const right = b.split('.').slice(0, 4).map(Number);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

function isoDate(value) {
  if (typeof value !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return null;
  const result = value.split('.').reverse().join('-');
  const date = new Date(result);
  return Number.isFinite(+date) && date.toISOString().startsWith(result) ? result : null;
}

export function sourceFor(raw, fullVersion, platform, architecture) {
  if (!versionPattern.test(fullVersion)) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  // Spotify's versioned links carry a signed ?fauth= token; no other query string is accepted anywhere.
  const signed = url.hostname === 'upgrade.scdn.co' && /^\?fauth=[A-Za-z0-9._~-]+$/.test(url.search);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || (url.search && !signed) || url.hash) return null;
  const target = targets.find(([, , p, a]) => p === platform && a === architecture);
  if (!target) return null;
  const [, , , , directory, format] = target;
  const stem = platform === 'windows' ? `spotify_installer-${fullVersion}` : `spotify-autoupdate-${fullVersion}`;
  if (url.hostname === 'upgrade.scdn.co' && platform !== 'linux') {
    const prefix = `/upgrade/client/${directory}/${stem}-`;
    if (url.pathname.startsWith(prefix) && new RegExp(`^\\d+\\.${format}$`).test(url.pathname.slice(prefix.length)))
      return { url: url.href, kind: 'official', label: 'Spotify CDN' };
  }
  if (url.hostname === 'repository.spotify.com' && platform === 'linux' &&
      url.pathname === `/pool/non-free/s/spotify-client/spotify-client_${fullVersion}_amd64.deb`)
    return { url: url.href, kind: 'official', label: 'Spotify repository' };
  // Spotify's permanent full installers always serve the current build; applyOfficial attaches
  // one only to the build whose ETag the watcher last saw there.
  if (url.hostname === 'download.scdn.co' && platform === 'windows' && url.pathname === PERMANENT[architecture])
    return { url: url.href, kind: 'official', label: 'Spotify (current build)' };
  if (url.hostname === 'github.com' && platform === 'windows' && ARCHIVE_REPOSITORIES.some(repository =>
      new RegExp(`^/${repository}/releases/download/[A-Za-z0-9._-]+/spotify_installer-${fullVersion.replace(/\./g, '\\.')}-${architecture}\\.exe$`).test(url.pathname)))
    return { url: url.href, kind: 'archive', label: 'GitHub archive' };
  if (url.hostname === 'loadspot.amd64fox1.workers.dev') {
    const suffix = platform === 'macos' && architecture === 'x64' ? 'x86_64' : architecture;
    const file = platform === 'linux' ? `spotify-client_${fullVersion}_amd64.deb` : `${stem}-${suffix}.${format}`;
    if (url.pathname === `/download/${file}`) return { url: url.href, kind: 'mirror', label: 'LoadSpot mirror' };
  }
  return null;
}

export function normalizeCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error('Expected a version catalog object');
  const entries = [];
  for (const [version, entry] of Object.entries(catalog)) {
    if (!entry || typeof entry !== 'object' || !versionPattern.test(entry.fullversion ?? '') ||
        entry.fullversion.split('.').slice(0, 4).join('.') !== version ||
        (entry.buildType && entry.buildType.toLowerCase() !== 'release')) continue;
    for (const [group, key, platform, architecture, , format] of targets) {
      const asset = entry[group]?.[key] ?? entry.links?.[group]?.[key];
      const url = typeof asset === 'string' ? asset : asset?.url;
      const source = sourceFor(url, entry.fullversion, platform, architecture);
      if (!source) continue;
      entries.push({
        id: `${entry.fullversion}-${platform}-${architecture}`,
        version, fullVersion: entry.fullversion, platform, architecture, format,
        date: isoDate(asset?.date), size: Number.isSafeInteger(asset?.size) && asset.size > 0 ? asset.size : null,
        tested: platform === 'windows' && architecture === 'x64' && entry.fullversion.toLowerCase() === TESTED_VERSION,
        sources: [source],
      });
    }
  }
  return entries;
}

export function parseLinuxPackages(text) {
  const catalog = {};
  for (const paragraph of text.trim().split(/\r?\n\s*\r?\n/)) {
    const fields = Object.fromEntries(paragraph.split(/\r?\n/).filter(line => /^[A-Za-z0-9-]+: /.test(line))
      .map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
    const full = fields.Version?.replace(/^\d+:/, '');
    if (fields.Package !== 'spotify-client' || fields.Architecture !== 'amd64' || !versionPattern.test(full ?? '')) continue;
    const url = new URL(fields.Filename, 'https://repository.spotify.com/').href;
    if (!sourceFor(url, full, 'linux', 'x64')) continue;
    const version = full.split('.').slice(0, 4).join('.');
    catalog[version] = { fullversion: full, linux: { amd64: { url, size: Number(fields.Size) } } };
  }
  return normalizeCatalog(catalog);
}

export function mergeCatalogs(...catalogs) {
  const merged = new Map();
  for (const entry of catalogs.flat()) {
    const previous = merged.get(entry.id);
    const sources = new Map([...(previous?.sources ?? []), ...entry.sources].map(source => [source.url, source]));
    merged.set(entry.id, { ...entry, date: entry.date ?? previous?.date ?? null, size: entry.size ?? previous?.size ?? null,
      ...(entry.sha256 ?? previous?.sha256 ? { sha256: entry.sha256 ?? previous.sha256 } : {}),
      sources: [...sources.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.url.localeCompare(b.url)) });
  }
  const platforms = ['windows', 'macos', 'linux'];
  const architectures = ['x64', 'arm64', 'x86'];
  return [...merged.values()].sort((a, b) => compareVersions(b.version, a.version) ||
    platforms.indexOf(a.platform) - platforms.indexOf(b.platform) ||
    architectures.indexOf(a.architecture) - architectures.indexOf(b.architecture) || a.id.localeCompare(b.id));
}

// Spotify's own links first: the permanent full installer while it serves the build, its signed
// versioned link while the token lasts, the apt repository; then the CI archive copy, then the
// maintained LoadSpot mirror. Expired official links stay listed, after everything that downloads.
const preference = ['Spotify (current build)', 'Spotify CDN', 'Spotify repository', 'GitHub archive', 'LoadSpot mirror'];
function nextRelease(official, build) {
  const later = official.builds.filter(b => b.platform === build.platform && b.architecture === build.architecture && b.etag && b.lastModified > build.lastModified)
    .toSorted((a, b) => a.lastModified.localeCompare(b.lastModified))[0];
  return later?.lastModified?.slice(0, 10) ?? null;
}
/** A versioned Spotify link downloads only with its signed token; the bare path is kept as the build's record. */
export function isExpired(source) { return Boolean(source.expired) || (source.label === 'Spotify CDN' && !/\?fauth=/.test(source.url)); }
export function orderedSources(entry, kind = 'all') {
  return entry.sources.filter(source => kind === 'all' || source.kind === kind)
    .toSorted((a, b) => Number(isExpired(a)) - Number(isExpired(b)) || preference.indexOf(a.label) - preference.indexOf(b.label));
}
/** Best source first; an entry whose only sources have expired still lists, so the record stays visible. */
export function selectSource(entry, kind = 'all') { return orderedSources(entry, kind)[0]; }
export function sourceNote(source) {
  if (isExpired(source)) return source.note ?? (source.label === 'Spotify CDN' ? 'Spotify\u2019s path for this build · signed token expired' : 'No longer served here');
  if (source.kind === 'archive') return 'Copied from Spotify by CI · hash listed';
  if (source.kind === 'mirror') return 'Community hosted';
  if (source.label === 'Spotify CDN') return source.until ? `Spotify\u2019s signed link · valid until ${source.until.slice(0, 10)}` : 'Archived link · may have expired';
  return 'Direct download';
}

/**
 * Overlays the release watcher's observations (site/data/official.json) on the catalog: adds the
 * SHA-256 CI computed from Spotify's own file, the CI archive copy when one exists, and, for the
 * build currently behind a permanent URL, that URL with its ETag. Nothing here is persisted into
 * catalog.json, so a permanent link never outlives the build it pointed at.
 */
export function applyOfficial(entries, official, now = Date.now()) {
  if (!official?.builds?.length) return entries;
  const current = new Set(Object.values(official.watched ?? {}).map(watched => watched.etag));
  const observed = [];
  for (const build of official.builds) {
    if (!versionPattern.test(build.fullVersion ?? '') || !/^[0-9a-f]{64}$/.test(build.sha256 ?? '')) continue;
    const sources = [];
    if (current.has(build.etag) && sourceFor(build.url, build.fullVersion, build.platform, build.architecture)?.label === 'Spotify (current build)')
      sources.push({ url: build.url, kind: 'official', label: 'Spotify (current build)', etag: build.etag });
    else if (build.etag && sourceFor(build.url, build.fullVersion, build.platform, build.architecture)?.label === 'Spotify (current build)')
      // Spotify's full installer served this build until the next release; the address now serves a newer one.
      sources.push({ url: build.url, kind: 'official', label: 'Spotify (current build)', expired: true, note: `Served this build until ${nextRelease(official, build) ?? 'the next release'}` });
    // The update service's signed link is Spotify's direct download for 30 days; afterwards the bare
    // versioned path stays on record, visibly expired, like the historical CDN links.
    const service = build.updateService ?? {};
    const live = service.signedUrl && service.signedUntil && Date.parse(service.signedUntil) > now && sourceFor(service.signedUrl, build.fullVersion, build.platform, build.architecture);
    if (live?.label === 'Spotify CDN') sources.push({ ...live, until: service.signedUntil });
    else if (service.httpPrefix && sourceFor(service.httpPrefix, build.fullVersion, build.platform, build.architecture)?.label === 'Spotify CDN')
      sources.push({ url: service.httpPrefix, kind: 'official', label: 'Spotify CDN', expired: true });
    const archive = build.archive && sourceFor(build.archive, build.fullVersion, build.platform, build.architecture);
    if (archive?.kind === 'archive') sources.push(archive);
    observed.push({
      id: `${build.fullVersion}-${build.platform}-${build.architecture}`,
      version: build.fullVersion.split('.').slice(0, 4).join('.'), fullVersion: build.fullVersion,
      platform: build.platform, architecture: build.architecture, format: 'exe',
      date: typeof build.lastModified === 'string' ? build.lastModified.slice(0, 10) : null,
      size: Number.isSafeInteger(build.size) && build.size > 0 ? build.size : null,
      tested: build.platform === 'windows' && build.architecture === 'x64' && build.fullVersion.toLowerCase() === TESTED_VERSION,
      sha256: build.sha256, sources,
    });
  }
  return mergeCatalogs(entries, observed);
}

export function filterCatalog(entries, { query = '', platform = 'all', architecture = 'all', source = 'all', sort = 'newest' } = {}) {
  const search = query.trim().toLowerCase();
  const result = entries.filter(entry => (!search || entry.fullVersion.toLowerCase().includes(search)) &&
    (platform === 'all' || entry.platform === platform) && (architecture === 'all' || entry.architecture === architecture) &&
    !!selectSource(entry, source));
  return sort === 'oldest' ? result.toReversed() : result;
}

// Installer feed: every Windows x64 build. `url` keeps the LoadSpot mirror (the stable link) so
// older parsers still work. `official` is Spotify's own link: the permanent full installer with
// its `etag` while that build is current, otherwise the historical upgrade.scdn.co link, which
// Spotify has usually expired. `archive` is the CI copy and `sha256` the hash CI took from Spotify's file.
export function windowsFeed(entries) {
  // A build with no link at all (no longer current, not mirrored, not archived) has nothing to offer the installer.
  return Object.fromEntries(entries.filter(entry => entry.platform === 'windows' && entry.architecture === 'x64').flatMap(entry => {
    const find = label => entry.sources.find(source => source.label === label && !isExpired(source));
    const current = find('Spotify (current build)');
    // Spotify first: the permanent URL while current, the signed link while valid, else the bare path the app tries and falls back from.
    const official = current ?? find('Spotify CDN') ?? entry.sources.find(source => source.label === 'Spotify CDN');
    const mirror = find('LoadSpot mirror')?.url;
    const archive = find('GitHub archive')?.url;
    const url = mirror ?? archive ?? official?.url;
    if (!url) return [];
    return [[entry.version, { fullversion: entry.fullVersion, win: { x64: {
      url,
      ...(official && (mirror || archive) ? { official: official.url } : {}),
      ...(current ? { etag: current.etag } : {}),
      ...(archive ? { archive } : {}),
      ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
      ...(entry.date ? { date: entry.date.split('-').reverse().join('.') } : {}), size: entry.size ?? 0,
    } } }]];
  }));
}

export function formatSize(bytes) { return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '—'; }
export const platformNames = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };
