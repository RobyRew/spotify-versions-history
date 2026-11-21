import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { fromLegacy } from '../../lib/ledger/legacy.ts';
import type { Artifact, Ledger, Release } from '../../lib/ledger/schema.ts';
import type { HealthEntry, HealthFile } from '../../sensors/health/schema.ts';
import type { MergedReport } from '../../sensors/verify/report.ts';
import { filterReleases, findRelease, latestDownloads, neighbours, page, releaseJson, releaseViews, sourceViews } from '../../lib/site/model.ts';

const NOW = new Date('2026-11-21T12:00:00.000Z');
const jwt = (exp: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: Date.parse(exp) / 1000 })).toString('base64url')}.c2ln`;
const CURRENT = 'https://download.scdn.co/SpotifyFullSetupX64.exe';
const MIRROR = (version: string) => `https://loadspot.amd64fox1.workers.dev/download/spotify_installer-${version}-x64.exe`;

function artifact(fullVersion: string, extra: Partial<Artifact> = {}): Artifact {
  return {
    id: `${fullVersion}-windows-x64-exe`, platform: 'windows', arch: 'x64', format: 'exe',
    listing: { date: '2026-11-01', size: 100, sources: [{ url: MIRROR(fullVersion), kind: 'mirror', label: 'LoadSpot mirror' }] },
    ...extra,
  };
}
const release = (fullVersion: string, artifacts: Artifact[]): Release => ({ schema: 2, product: 'desktop', version: fullVersion.split('.').slice(0, 4).join('.'), fullVersion, artifacts });
const ledgerOf = (releases: Release[]): Ledger => ({ releases, sensors: { upstreamCatalogs: { schema: 1, updatedAt: '2026-11-01T00:00:00.000Z', testedVersion: '', upstream: [] }, permanentUrls: { schema: 1, watched: {} }, updateService: null, mobile: null } });
const entry = (overrides: Partial<HealthEntry>): HealthEntry => ({ provider: 'loadspot', status: 'ok', httpStatus: 200, size: 100, etag: null, lastModified: null, finalUrl: null, checkedAt: '2026-11-21T06:00:00.000Z', ms: 10, detail: 'HTTP 200', ...overrides });
const health = (sources: Record<string, HealthEntry>): HealthFile => ({ schema: 1, generatedAt: NOW.toISOString(), sources, summary: {} as HealthFile['summary'] });

const capture = (etag: string, capturedAt: string) => ({ sha256: 'a'.repeat(64), size: 100, capturedAt, url: CURRENT, etag, sensors: ['permanent-url'] });

describe('download links', () => {
  it('offers a current-build URL only for the build whose ETag it still serves', () => {
    const older = artifact('1.3.9.2055.gaaaaaaaa', { captures: [capture('"old"', '2026-10-01T00:00:00.000Z')] });
    const newer = artifact('1.3.10.2586.gbbbbbbbb', { captures: [capture('"new"', '2026-11-18T00:00:00.000Z')] });
    const current = new Map([[CURRENT, '"new"']]);
    expect(sourceViews(newer, null, NOW, current)[0]).toMatchObject({ url: CURRENT, usable: true, provider: 'spotify-current' });
    const olderViews = sourceViews(older, null, NOW, current);
    expect(olderViews.find(view => view.url === CURRENT)).toMatchObject({ usable: false, detail: 'now serves a newer build' });
    expect(olderViews[0]).toMatchObject({ url: MIRROR('1.3.9.2055.gaaaaaaaa'), usable: true });
    // The health file's ETag wins over the ledger's newest capture.
    const moved = sourceViews(newer, health({ [CURRENT]: entry({ provider: 'spotify-current', etag: '"newest"' }) }), NOW, current);
    expect(moved.find(view => view.url === CURRENT)?.usable).toBe(false);
  });

  it('never offers an expired signed link, an unsigned CDN path or a link the health file found dead', () => {
    const signedOld = `https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.3.4.gabcdefab-5.exe?fauth=${jwt('2026-10-01T00:00:00Z')}`;
    const signedNew = `https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.3.4.gabcdefab-6.exe?fauth=${jwt('2026-12-15T00:00:00Z')}`;
    const unsigned = 'https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.3.4.gabcdefab-7.exe';
    const item = artifact('1.2.3.4.gabcdefab', {
      listing: { date: null, size: null, sources: [
        { url: signedOld, kind: 'official', label: 'Spotify CDN' }, { url: unsigned, kind: 'official', label: 'Spotify CDN' },
        { url: signedNew, kind: 'official', label: 'Spotify CDN' }, { url: MIRROR('1.2.3.4.gabcdefab'), kind: 'mirror', label: 'LoadSpot mirror' },
      ] },
    });
    const views = sourceViews(item, health({ [MIRROR('1.2.3.4.gabcdefab')]: entry({ status: 'gone', httpStatus: 404, detail: 'HTTP 404' }) }), NOW, new Map());
    expect(views.map(view => [view.url === signedNew ? 'new' : view.url === signedOld ? 'old' : view.url === unsigned ? 'unsigned' : 'mirror', view.usable])).toEqual([
      ['new', true], ['old', false], ['mirror', false], ['unsigned', false],
    ]);
    expect(views[0]?.detail).toMatch(/valid until 2026-12-15/);
  });
});

describe('release views', () => {
  const ledger = ledgerOf([
    release('1.3.10.2586.gbbbbbbbb', [artifact('1.3.10.2586.gbbbbbbbb', { captures: [capture('"new"', '2026-11-18T00:00:00.000Z')] })]),
    release('1.3.9.2055.gaaaaaaaa', [artifact('1.3.9.2055.gaaaaaaaa'), { ...artifact('1.3.9.2055.gaaaaaaaa'), id: '1.3.9.2055.gaaaaaaaa-macos-arm64-tbz', platform: 'macos', arch: 'arm64', format: 'tbz' }]),
    release('1.2.53.440.gcccccccc', [{ ...artifact('1.2.53.440.gcccccccc'), listing: { date: '2025-01-02', size: 1, sources: [{ url: 'https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.53.440.gcccccccc-1.exe', kind: 'official', label: 'Spotify CDN' }] } }]),
  ]);
  const report = {
    schema: 1, generatedAt: NOW.toISOString(), runs: [],
    artifacts: [{ key: '1.3.10.2586.gbbbbbbbb-windows-x64-exe', sensor: 'windows', version: '1.3.10.2586', fullVersion: '1.3.10.2586.gbbbbbbbb', platform: 'windows', arch: 'x64', format: 'exe', hosts: ['linux', 'win32'], size: 100, sha256: 'a'.repeat(64), level: 'signed', ok: true, problems: [], rotated: false, checks: [{ id: 'authenticode.chain', status: 'pass', detail: '', verifier: '', host: 'linux' }] }],
  } as unknown as MergedReport;
  const views = releaseViews(ledger, null, report, NOW);

  it('sorts newest first, marks signed releases and attaches the verification', () => {
    expect(views.map(view => view.version)).toEqual(['1.3.10.2586', '1.3.9.2055', '1.2.53.440']);
    expect(views[0]).toMatchObject({ signed: true, downloadable: true });
    expect(views[0]!.artifacts[0]!.verification).toMatchObject({ level: 'signed', ok: true, hosts: ['linux', 'win32'], pass: 1, matchesCapture: true });
    expect(views[2]).toMatchObject({ signed: false, downloadable: false });
  });

  it('filters by text, platform, architecture and flags, and reverses for oldest first', () => {
    expect(filterReleases(views, { q: '2055' }).map(view => view.version)).toEqual(['1.3.9.2055']);
    expect(filterReleases(views, { platform: 'macos' }).map(view => view.version)).toEqual(['1.3.9.2055']);
    expect(filterReleases(views, { platform: 'windows', arch: 'arm64' })).toEqual([]);
    expect(filterReleases(views, { signed: true }).map(view => view.version)).toEqual(['1.3.10.2586']);
    expect(filterReleases(views, { downloadable: true, sort: 'oldest' }).map(view => view.version)).toEqual(['1.3.9.2055', '1.3.10.2586']);
  });

  it('pages with an index cursor and ignores a cursor that is not one', () => {
    expect(page(views, null, 2)).toMatchObject({ next: '2' });
    expect(page(views, '2', 2)).toMatchObject({ next: null, items: [views[2]] });
    expect(page(views, 'drop table', 2).items[0]).toBe(views[0]);
  });

  it('features the newest first-party build per platform and notes a newer mirror-only one', () => {
    const staged = releaseViews(ledgerOf([release('1.3.11.2644.gdddddddd', [artifact('1.3.11.2644.gdddddddd')]), ...ledger.releases]), null, report, NOW);
    const [windows] = latestDownloads(staged);
    expect(windows).toMatchObject({ platform: 'windows', arch: 'x64' });
    expect(windows!.release.version).toBe('1.3.10.2586');
    expect(windows!.artifact.best?.provider).toBe('spotify-current');
    expect(windows!.newer?.release.version).toBe('1.3.11.2644');
    // A platform only the mirror serves features its newest mirrored build, with no note.
    expect(latestDownloads(staged).find(item => item.platform === 'macos')).toMatchObject({ newer: null });
    // When the newest build is itself first-party there is no note either.
    expect(latestDownloads(views).find(item => item.platform === 'windows')).toMatchObject({ newer: null });
  });

  it('finds the newest downloadable build per platform, a release by version and its neighbours', () => {
    expect(latestDownloads(views).map(item => `${item.platform}/${item.arch} ${item.release.version}`)).toEqual(['windows/x64 1.3.10.2586', 'macos/arm64 1.3.9.2055']);
    const middle = findRelease(views, 'desktop', '1.3.9.2055')!;
    expect(findRelease(views, 'desktop', '1.3.9.2055.gaaaaaaaa')).toBe(middle);
    expect(neighbours(views, middle)).toEqual({ newer: views[0], older: views[2] });
    expect(releaseJson(views[2]!).artifacts[0]!.download).toBeNull();
  });
});

describe('the real ledger', () => {
  it('never offers a link it knows to be dead and keeps every release', async () => {
    const read = async (name: string) => JSON.parse(await readFile(new URL(`../../site/data/${name}`, import.meta.url), 'utf8'));
    const ledger = fromLegacy({ catalog: await read('catalog.json'), official: await read('official.json'), mobile: await read('mobile.json') });
    const views = releaseViews(ledger, null, null, NOW);
    expect(views).toHaveLength(ledger.releases.length);
    for (const view of views) {
      for (const item of view.artifacts) {
        if (item.best) expect(item.best.usable).toBe(true);
        expect(item.sources.every(source => !source.usable || source.state !== 'danger')).toBe(true);
        const unsignedOffered = item.sources.some(source => source.usable && new URL(source.url).hostname === 'upgrade.scdn.co' && !source.url.includes('fauth='));
        expect(unsignedOffered).toBe(false);
      }
    }
    // Each permanent URL is offered for one build at most: the one it serves.
    const offered = views.flatMap(view => view.artifacts.flatMap(item => item.sources.filter(source => source.usable && source.provider === 'spotify-current').map(source => source.url)));
    expect(new Set(offered).size).toBe(offered.length);
  });
});
