import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TESTED_VERSION, normalizeCatalog, sourceFor, mergeCatalogs, parseLinuxPackages, filterCatalog, selectSource, windowsFeed, compareVersions, applyOfficial, isExpired, sourceNote } from '../site/src/lib/catalog.mjs';
import { WATCHED, inspectPortableExecutable, capture, applyObservations, reconcileUpdateService, runProbe, archive, ensureRelease, serialize, canonical, archiveCandidates, archiveAlive } from '../site/scripts/watch-official.mjs';
const catalog = JSON.parse(await readFile(new URL('../site/data/catalog.json', import.meta.url), 'utf8'));
const official = JSON.parse(await readFile(new URL('../site/data/official.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(await readFile(new URL('../testdata/loadspot_versions.json', import.meta.url), 'utf8'));
const entries = normalizeCatalog(fixture);
const html = await readFile(new URL('../site/src/pages/index.astro', import.meta.url), 'utf8');

test('Published catalog includes the full library and all supported architectures', () => {
  assert.equal(catalog.schemaVersion, 1);
  assert.ok(catalog.entries.length > 1000);
  assert.equal(new Set(catalog.entries.map(entry => entry.id)).size, catalog.entries.length);
  assert.deepEqual([...new Set(catalog.entries.map(entry => entry.platform))].sort(), ['linux', 'macos', 'windows']);
  assert.deepEqual([...new Set(catalog.entries.map(entry => entry.architecture))].sort(), ['arm64', 'x64', 'x86']);
  assert.equal(catalog.testedVersion, TESTED_VERSION);
  assert.equal(catalog.entries.filter(entry => entry.tested).length, 1);
});
test('Every download has an allowed HTTPS host, exact version, platform and architecture', () => {
  for (const entry of catalog.entries) for (const source of entry.sources)
    assert.deepEqual(sourceFor(source.url, entry.fullVersion, entry.platform, entry.architecture), source);
});
test('Rejects unsafe or mismatched source URLs instead of manufacturing a download', () => {
  const full = TESTED_VERSION;
  for (const url of [
    `http://loadspot.amd64fox1.workers.dev/download/spotify_installer-${full}-x64.exe`,
    `https://loadspot.amd64fox1.workers.dev.evil.test/download/spotify_installer-${full}-x64.exe`,
    `https://user@loadspot.amd64fox1.workers.dev/download/spotify_installer-${full}-x64.exe`,
    `https://loadspot.amd64fox1.workers.dev/download/spotify_installer-${full}-arm64.exe`,
    `https://loadspot.amd64fox1.workers.dev/download/spotify_installer-${full}-x64.exe?redirect=evil`,
    'javascript:alert(1)',
  ]) assert.equal(sourceFor(url, full, 'windows', 'x64'), null);
});
test('Normalizes live metadata, ignores malformed and non-release builds', () => {
  const tested = entries.find(entry => entry.tested);
  assert.ok(tested);
  assert.equal(tested.size, 146096232);
  assert.equal(tested.date, '2026-07-01');
  assert.equal(tested.sources[0].kind, 'mirror');
  assert.equal(normalizeCatalog({ broken: {}, '1.2.93.667': { ...fixture['1.2.93.667'], buildType: 'Master' } }).length, 0);
  assert.throws(() => normalizeCatalog([]));
});
test('Merge preserves exact historic Spotify URLs and maintained mirror alternatives', () => {
  const tested = entries.find(entry => entry.tested);
  const official = { ...tested, date: null, size: null, sources: [{ url: `https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-${TESTED_VERSION}-1234.exe`, kind: 'official', label: 'Spotify CDN' }] };
  const merged = mergeCatalogs([official], [tested]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].sources.length, 2);
  assert.equal(selectSource(merged[0]).kind, 'mirror', 'a bare historic CDN link is known to answer 403 and never becomes the download');
  assert.equal(selectSource(merged[0], 'official').kind, 'official');
  assert.ok(isExpired(selectSource(merged[0], 'official')));
  assert.equal(merged[0].size, tested.size);
  assert.deepEqual(mergeCatalogs(merged, [official], [tested]), merged);
});
test('Official Linux repository metadata takes precedence over a mirror', () => {
  const linux = parseLinuxPackages(`Package: spotify-client\nArchitecture: amd64\nVersion: 1:${TESTED_VERSION}\nFilename: pool/non-free/s/spotify-client/spotify-client_${TESTED_VERSION}_amd64.deb\nSize: 1234\n\nPackage: fake-client\nVersion: 1.0.0.0.gabcdefab\n`);
  assert.equal(linux.length, 1);
  assert.equal(linux[0].sources[0].kind, 'official');
  assert.equal(linux[0].architecture, 'x64');
  assert.equal(linux[0].tested, false);
  assert.equal(parseLinuxPackages(`Package: spotify-client\nArchitecture: amd64\nVersion: ${TESTED_VERSION}\nFilename: https://evil.test/installer.deb`).length, 0);
});
test('Search combines version, platform, architecture and source filters', () => {
  const result = filterCatalog(catalog.entries, { query: 'G7B5CC0CE', platform: 'windows', architecture: 'x64', source: 'mirror' });
  assert.equal(result.length, 1);
  assert.equal(result[0].fullVersion, TESTED_VERSION);
  assert.equal(filterCatalog(catalog.entries, { query: 'no-such-version' }).length, 0);
  const official = filterCatalog(catalog.entries, { source: 'official', platform: 'linux' });
  assert.ok(official.length > 0);
  assert.ok(official.every(entry => selectSource(entry, 'official').url.startsWith('https://repository.spotify.com/')));
  assert.ok(filterCatalog(catalog.entries, { platform: 'linux', architecture: 'arm64' }).length === 0);
});
test('Sort uses numeric versions, and reversing never mutates the catalog', () => {
  assert.ok(compareVersions('1.2.100.1', '1.2.99.999') > 0);
  const newest = filterCatalog(catalog.entries);
  const oldest = filterCatalog(catalog.entries, { sort: 'oldest' });
  assert.deepEqual(oldest.toReversed(), newest);
  assert.equal(newest[0], catalog.entries[0]);
});
test('Installer feed lists every Windows x64 build with the mirror as url and Spotify as official', () => {
  const feed = windowsFeed(catalog.entries);
  assert.ok(JSON.stringify(feed).length < 150000);
  const windows = catalog.entries.filter(entry => entry.platform === 'windows' && entry.architecture === 'x64');
  assert.equal(Object.keys(feed).length, windows.length);
  assert.ok(windows.some(entry => compareVersions(entry.version, TESTED_VERSION) < 0), 'older builds are part of the feed');
  assert.equal(feed['1.2.93.667'].fullversion, TESTED_VERSION);
  let withOfficial = 0;
  for (const [version, entry] of Object.entries(feed)) {
    const { url, official } = entry.win.x64;
    assert.ok(sourceFor(url, entry.fullversion, 'windows', 'x64'));
    if (official) {
      withOfficial++;
      assert.equal(sourceFor(official, entry.fullversion, 'windows', 'x64').kind, 'official');
      assert.equal(sourceFor(url, entry.fullversion, 'windows', 'x64').kind, 'mirror');
    }
    assert.ok(version);
  }
  assert.ok(withOfficial > 100);
  const fixtureFeed = windowsFeed(entries);
  assert.deepEqual(Object.keys(fixtureFeed['1.2.85.519'].win.x64).sort(), ['date', 'size', 'url']);
  const live = windowsFeed(applyOfficial(catalog.entries, official));
  const current = official.builds.find(build => build.architecture === 'x64' && build.etag === official.watched['windows-x64'].etag);
  const entry = live[current.fullVersion.split('.').slice(0, 4).join('.')].win.x64;
  assert.equal(entry.sha256, current.sha256);
  assert.equal(entry.etag, current.etag);
  assert.ok([entry.url, entry.official].includes('https://download.scdn.co/SpotifyFullSetupX64.exe'));
});
test('Snapshot refresh is idempotent: unchanged metadata does not cause another deployment', () => {
  const merged = mergeCatalogs(catalog.entries, catalog.entries);
  assert.deepEqual(merged, catalog.entries);
});
test('Official latest links are explicit, the page has no BlockTheSpot branding, and controls are accessible', async () => {
  const links = [...html.matchAll(/data-official-download href="([^"]+)"/g)];
  assert.equal(links.length, 3);
  for (const [, link] of links) assert.equal(new URL(link).hostname, 'download.scdn.co');
  // The site is a plain Spotify installer catalog: no BlockTheSpot name in the visible page.
  assert.ok(!/BlockTheSpot(?!-Installer)/.test(html.replace(/https:\/\/[^"'<>\s]+/g, '')), 'no BlockTheSpot branding in the page text');
  assert.ok(!html.includes('Tested for BTS') && !html.includes('BTS tested'));
  assert.ok(html.includes('skip-link'));
  assert.ok(html.includes('aria-label="Main navigation"'));
  assert.ok(html.includes('aria-live="polite"'));
  assert.ok(html.includes('Official Spotify only'));
  assert.ok(html.includes('Older official CDN links may have expired'));
  const row = await readFile(new URL('../site/src/components/DownloadRow.astro', import.meta.url), 'utf8');
  assert.ok(row.includes('orderedSources(entry)') && row.includes('alt-links') && row.includes('official-path'), 'rows offer the best source first, the other options beside it, and expired official paths as text');
});

// --- release watcher -------------------------------------------------------------------------------

function syntheticInstaller(version, machine = 0x8664) {
  const buffer = Buffer.alloc(4096);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3C);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(machine, 0x84);
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  key.copy(buffer, 0x800);
  Buffer.from('\0' + version + '\0', 'utf16le').copy(buffer, 0x800 + key.length);
  return buffer;
}
const sha = (algorithm, buffer) => createHash(algorithm).update(buffer).digest('hex');

test('Watcher reads machine and ProductVersion from a PE image and rejects other files', () => {
  assert.deepEqual(inspectPortableExecutable(syntheticInstaller('1.3.1.234.g59d6bf59')), { machine: 0x8664, productVersion: '1.3.1.234.g59d6bf59' });
  assert.equal(inspectPortableExecutable(syntheticInstaller('1.2.53.440.g7b2f582a', 0x14c)).machine, 0x14c);
  assert.throws(() => inspectPortableExecutable(Buffer.from('not an exe')), /Not a Windows executable/);
  assert.throws(() => inspectPortableExecutable(syntheticInstaller('2.0.0.1')), /Unexpected ProductVersion/);
  assert.deepEqual(WATCHED.filter(w => w.machine).map(w => w.architecture), ['x64', 'arm64', 'x86']);
});

test('Watcher downloads with If-Match, hashes the file and refuses a build that does not match the claim', async () => {
  const image = syntheticInstaller('1.3.1.234.g59d6bf59');
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, ifMatch: options.headers['If-Match'] ?? null });
    return new Response(image, { status: 200, headers: { etag: '"abc"', 'content-length': String(image.length), 'last-modified': 'Thu, 17 Sep 2026 15:26:53 GMT' } });
  };
  const directory = await mkdtemp(join(tmpdir(), 'watch-test-'));
  try {
    const target = WATCHED[0];
    const file = await capture(target, { etag: '"abc"', size: image.length }, directory, fetchImpl);
    assert.deepEqual(requests, [{ url: target.url, ifMatch: '"abc"' }]);
    assert.equal(file.sha256, sha('sha256', image));
    assert.equal(file.sha1, sha('sha1', image));
    assert.equal(file.fullVersion, '1.3.1.234.g59d6bf59');
    assert.equal(file.name, 'spotify_installer-1.3.1.234.g59d6bf59-x64.exe');
    assert.equal(file.path, join(directory, file.name), 'the file carries the asset name a release upload will keep');
    assert.equal(file.lastModified, '2026-09-17T15:26:53.000Z');
    await assert.rejects(capture(target, { url: 'https://upgrade.scdn.co/x', expectVersion: '1.3.1.235.g00000000' }, directory, fetchImpl), /is 1\.3\.1\.234\.g59d6bf59, not/);
    await assert.rejects(capture(target, { etag: '"abc"', size: 10 }, directory, fetchImpl), /received .* of 10 bytes/);
    await assert.rejects(capture(WATCHED[1], { etag: '"abc"' }, directory, fetchImpl), /is not arm64/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Observations merge by hash, keep the first capture date and union the sensors', () => {
  const t0 = '2026-09-17T16:00:00.000Z', t1 = '2026-09-18T04:00:00.000Z';
  const build = { fullVersion: '1.3.1.234.g59d6bf59', platform: 'windows', architecture: 'x64', sha256: 'a'.repeat(64), sha1: 'b'.repeat(40), size: 10, lastModified: '2026-09-17T15:26:53.000Z', capturedAt: t0, url: WATCHED[0].url, etag: '"e1"', sensors: ['permanent-url'] };
  const first = applyObservations(null, { 'windows-x64': { etag: '"e1"', size: 10, lastModified: build.lastModified } }, [build], t0);
  assert.equal(first.watched['windows-x64'].changedAt, t0);
  const again = applyObservations(first, { 'windows-x64': { etag: '"e1"', size: 10, lastModified: build.lastModified } }, [{ ...build, capturedAt: t1, sensors: ['update-service'] }], t1);
  assert.equal(again.builds.length, 1);
  assert.equal(again.builds[0].capturedAt, t0);
  assert.deepEqual(again.builds[0].sensors, ['permanent-url', 'update-service']);
  assert.equal(again.watched['windows-x64'].changedAt, t0, 'an unchanged ETag keeps its original change date');
  const rotated = applyObservations(again, { 'windows-x64': { etag: '"e2"', size: 11, lastModified: '2026-09-20T00:00:00.000Z' } }, [{ ...build, sha256: 'c'.repeat(64), fullVersion: '1.3.2.100.g11111111', etag: '"e2"', lastModified: '2026-09-20T00:00:00.000Z' }], '2026-09-20T01:00:00.000Z');
  assert.equal(rotated.builds.length, 2);
  assert.equal(rotated.builds[0].fullVersion, '1.3.2.100.g11111111', 'newest build first');
  assert.equal(rotated.watched['windows-x64'].changedAt, '2026-09-20T01:00:00.000Z');
  const next = applyObservations(again, {}, [], t1);
  next.builds[0].archive = 'https://example.test/copy';
  assert.equal(again.builds[0].archive, undefined, 'records are copied, so an in-place update is a detectable change');
  assert.notEqual(canonical(again), canonical(next));
});

test('Update-service offers verify a captured build by hash, flag a conflict, and list unseen builds', () => {
  const state = { schemaVersion: 1, watched: {}, builds: [
    { fullVersion: '1.3.1.234.g59d6bf59', platform: 'windows', architecture: 'x64', sha256: 'a'.repeat(64), sha1: 'b'.repeat(40), url: WATCHED[0].url, sensors: ['permanent-url'] },
    { fullVersion: '1.3.1.234.g59d6bf59', platform: 'windows', architecture: 'arm64', sha256: 'c'.repeat(64), sha1: 'd'.repeat(40), url: WATCHED[1].url, sensors: ['permanent-url'] },
  ] };
  const probe = { claim: '1.2.0.0', results: {
    Win32_x86_64: { fullVersion: '1.3.1.234.g59d6bf59', os: 'windows', architecture: 'x64', httpPrefix: 'https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.3.1.234.g59d6bf59-77.exe', url: 'https://upgrade.scdn.co/x?fauth=1', binaryHash: 'B'.repeat(40), targetVersion: 1, upgradeType: 2, pollInterval: 14288 },
    Win32_ARM64: { fullVersion: '1.3.1.234.g59d6bf59', os: 'windows', architecture: 'arm64', httpPrefix: 'https://upgrade.scdn.co/upgrade/client/win32-arm64/spotify_installer-1.3.1.234.g59d6bf59-77.exe', url: 'https://upgrade.scdn.co/y?fauth=1', binaryHash: 'e'.repeat(64), targetVersion: 1 },
    OSX_ARM64: { fullVersion: '1.3.1.234.g59d6bf59', os: 'macos', architecture: 'arm64', httpPrefix: 'https://upgrade.scdn.co/upgrade/client/osx-arm64/spotify-autoupdate-1.3.1.234.g59d6bf59-77.tbz', url: 'https://upgrade.scdn.co/z?fauth=1', binaryHash: 'f'.repeat(64) },
    OSX: { upToDate: true },
  } };
  const missing = reconcileUpdateService(state, probe, '2026-09-18T05:00:00.000Z');
  assert.deepEqual(missing, []);
  assert.equal(state.builds[0].verified, 'binary_hash', 'a SHA-1 binary_hash verifies against sha1, case-insensitively');
  assert.deepEqual(state.builds[0].sensors, ['permanent-url', 'update-service']);
  assert.match(state.builds[1].conflict, /matches neither/);
  assert.equal(state.updateService.offers.OSX_ARM64.fullVersion, '1.3.1.234.g59d6bf59');
  assert.equal(state.updateService.offers.OSX, undefined);
  const newer = { claim: '1.2.0.0', results: { Win32_x86_64: { ...probe.results.Win32_x86_64, fullVersion: '1.3.2.100.g11111111' } } };
  const unseen = reconcileUpdateService(state, newer, '2026-09-19T05:00:00.000Z');
  assert.equal(unseen.length, 1);
  assert.equal(unseen[0].fullVersion, '1.3.2.100.g11111111');
  assert.equal(state.updateService.offers.Win32_x86_64.seenAt, '2026-09-19T05:00:00.000Z', 'a changed offer refreshes its seen date');
  assert.equal(state.updateService.offers.OSX_ARM64.seenAt, '2026-09-18T05:00:00.000Z', 'an offer that is no longer reported keeps its record');
  assert.equal(state.updateService.offers.Win32_ARM64.pollInterval, undefined, 'the jittered poll interval is not recorded');
});

test('Archive backfill prefers the live permanent URL, then the signed link, then the mirror', () => {
  const build = { fullVersion: '1.3.1.234.g59d6bf59', platform: 'windows', architecture: 'x64', etag: '"e1"', sha256: 'a'.repeat(64), size: 10 };
  const probe = { results: { Win32_x86_64: { os: 'windows', architecture: 'x64', fullVersion: '1.3.1.234.G59D6BF59', url: 'https://upgrade.scdn.co/x?fauth=t' } } };
  const live = archiveCandidates(build, { 'windows-x64': { etag: '"e1"' } }, probe);
  assert.equal(live.watched.id, 'windows-x64');
  assert.deepEqual(live.candidates.map(c => c.url), [WATCHED[0].url, 'https://upgrade.scdn.co/x?fauth=t', 'https://loadspot.amd64fox1.workers.dev/download/spotify_installer-1.3.1.234.g59d6bf59-x64.exe']);
  assert.equal(live.candidates[0].etag, '"e1"', 'the permanent URL is fetched with If-Match');
  const rotated = archiveCandidates(build, { 'windows-x64': { etag: '"e2"' } }, null);
  assert.deepEqual(rotated.candidates.map(c => new URL(c.url).host), ['loadspot.amd64fox1.workers.dev'], 'a rotated permanent URL and no probe leave only the mirror');
  assert.deepEqual(archiveCandidates({ ...build, platform: 'macos' }, {}, null), { watched: null, candidates: [] });
});

test('A signed Spotify link is the official download while valid and a visible record afterwards', () => {
  const signed = 'https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.85.519.g549a528b-5377.exe?fauth=eyJr.eyJp.sig-1_2~3';
  assert.equal(sourceFor(signed, '1.2.85.519.g549a528b', 'windows', 'x64').label, 'Spotify CDN');
  assert.equal(sourceFor(signed + '&x=1', '1.2.85.519.g549a528b', 'windows', 'x64'), null);
  assert.equal(sourceFor('https://loadspot.amd64fox1.workers.dev/download/spotify_installer-1.2.85.519.g549a528b-x64.exe?fauth=a.b.c', '1.2.85.519.g549a528b', 'windows', 'x64'), null);
  const build = { fullVersion: '1.2.85.519.g549a528b', platform: 'windows', architecture: 'x64', sha256: 'a'.repeat(64), size: 1, lastModified: '2026-03-13T10:00:00.000Z',
    url: 'https://download.scdn.co/SpotifyFullSetupX64.exe', etag: '"gone"',
    updateService: { httpPrefix: signed.split('?')[0], signedUrl: signed, signedUntil: '2026-10-18T00:00:00Z', binaryHash: 'b'.repeat(40) } };
  const before = applyOfficial(entries, { watched: {}, builds: [build] }, Date.parse('2026-10-01T00:00:00Z'));
  const live = before.find(e => e.id === '1.2.85.519.g549a528b-windows-x64');
  assert.equal(selectSource(live).url, signed, 'the signed link outranks the mirror while valid');
  assert.equal(sourceNote(selectSource(live)), 'Spotify\u2019s signed link · valid until 2026-10-18');
  assert.equal(windowsFeed(before)['1.2.85.519'].win.x64.official, signed);
  const after = applyOfficial(entries, { watched: {}, builds: [build] }, Date.parse('2026-11-01T00:00:00Z'));
  const gone = after.find(e => e.id === '1.2.85.519.g549a528b-windows-x64');
  assert.equal(selectSource(gone).kind, 'mirror');
  const record = gone.sources.find(s => s.label === 'Spotify CDN');
  assert.ok(record && isExpired(record) && record.url === signed.split('?')[0], 'the bare official path stays on the row');
  assert.ok(gone.sources.find(s => s.label === 'Spotify (current build)')?.expired, 'and so does the permanent URL it once lived at');
  assert.equal(windowsFeed(after)['1.2.85.519'].win.x64.official, signed.split('?')[0], 'the installer still tries the official path first');
});

test('A recorded archive link is kept only while it answers', async () => {
  assert.equal(await archiveAlive('https://example.test/a', async () => new Response(null, { status: 200 })), true);
  assert.equal(await archiveAlive('https://example.test/a', async () => new Response('<html>Not Found</html>', { status: 404 })), false);
  assert.equal(await archiveAlive('https://example.test/a', async () => { throw new Error('offline'); }), false);
});

test('A run that learned nothing new is byte-identical and not a change', () => {
  const state = { schemaVersion: 1, watched: { 'windows-x64': { etag: '"e"', size: 1, lastModified: 'x', checkedAt: 't1', changedAt: 't0' } },
    updateService: { claim: '1.2.0.0', checkedAt: 't1', offers: { Win32_x86_64: { fullVersion: 'v', seenAt: 't0' } } }, builds: [{ fullVersion: 'v', sha256: 'a', sensors: ['permanent-url'] }] };
  const reordered = { builds: state.builds, updateService: { offers: state.updateService.offers, checkedAt: 't2', claim: '1.2.0.0' }, watched: { 'windows-x64': { ...state.watched['windows-x64'], checkedAt: 't2' } }, schemaVersion: 1 };
  assert.equal(canonical(state), canonical(reordered), 'key order and check times do not count as changes');
  assert.ok(serialize(reordered).startsWith('{\n  "schemaVersion": 1,\n  "watched": {'), 'top-level sections are written in a fixed order');
  assert.ok(serialize(reordered).indexOf('"updateService"') < serialize(reordered).indexOf('"builds"'));
  assert.notEqual(canonical(state), canonical({ ...state, builds: [{ ...state.builds[0], verified: 'binary_hash' }] }), 'a new observation is a change');
  assert.equal(serialize(JSON.parse(serialize(official))), serialize(official), 'the published file round-trips');
});

test('The probe is skipped without credentials and its output is parsed when present', () => {
  assert.equal(runProbe({ env: {} }), null);
  const skipped = runProbe({ env: { SPOTIFY_CREDENTIALS: '{}' }, run: () => ({ status: 0, stdout: '{"skipped":true,"reason":"librespot is not installed"}' }) });
  assert.equal(skipped, null);
  const failed = runProbe({ env: { SPOTIFY_CREDENTIALS_FILE: 'x' }, run: () => ({ status: 1, stderr: 'boom' }) });
  assert.equal(failed, null);
  let command;
  const parsed = runProbe({ env: { SPOTIFY_CREDENTIALS: '{}' }, run: (cmd, args) => { command = [cmd, ...args]; return { status: 0, stdout: '{"claim":"1.2.0.0","results":{}}' }; } });
  assert.deepEqual(parsed, { claim: '1.2.0.0', results: {} });
  assert.equal(command[0], 'python3');
  assert.match(command[1], /probe-update-service\.py$/);
});

test('Archiving is off without a tag and uploads under the stable asset name with it', () => {
  const file = { path: '/tmp/spotify_installer-1.3.1.234.g59d6bf59-x64.exe', name: 'spotify_installer-1.3.1.234.g59d6bf59-x64.exe' };
  assert.equal(archive(file, '', 'RobyRew/BlockTheSpot-Installer'), null);
  assert.throws(() => archive({ path: '/tmp/windows-x64.exe', name: file.name }, 'spotify-installers', 'RobyRew/BlockTheSpot-Installer', { run: () => ({ status: 0 }) }), /must be named/);
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, ...args]); return { status: args[1] === 'view' ? 1 : 0 }; };
  ensureRelease('spotify-installers', 'RobyRew/BlockTheSpot-Installer', { run });
  const url = archive(file, 'spotify-installers', 'RobyRew/BlockTheSpot-Installer', { run });
  assert.equal(url, 'https://github.com/RobyRew/BlockTheSpot-Installer/releases/download/spotify-installers/spotify_installer-1.3.1.234.g59d6bf59-x64.exe');
  assert.deepEqual(calls.map(c => c.slice(0, 3)), [['gh', 'release', 'view'], ['gh', 'release', 'create'], ['gh', 'release', 'upload']]);
  assert.ok(calls[2].includes('/tmp/spotify_installer-1.3.1.234.g59d6bf59-x64.exe') && !calls[2].some(arg => arg.includes('#')), 'uploaded by file name, never with a display label');
  assert.equal(sourceFor(url, '1.3.1.234.g59d6bf59', 'windows', 'x64').kind, 'archive');
  const here = archive(file, 'spotify-installers', 'RobyRew/spotify-versions-history', { run });
  assert.equal(sourceFor(here, '1.3.1.234.g59d6bf59', 'windows', 'x64').kind, 'archive', 'this repository archives here now');
  assert.throws(() => archive(file, 'spotify-installers', 'RobyRew/BlockTheSpot-Installer', { run: () => ({ status: 2 }) }), /exited with 2/);
});

test('applyOfficial overlays hashes, the current permanent link and archive copies without persisting them', () => {
  const build = { fullVersion: '1.2.85.519.g549a528b', platform: 'windows', architecture: 'x64', sha256: 'a'.repeat(64), sha1: 'b'.repeat(40), size: 127874744,
    lastModified: '2026-03-13T10:00:00.000Z', url: 'https://download.scdn.co/SpotifyFullSetupX64.exe', etag: '"old"', archive: 'https://github.com/RobyRew/BlockTheSpot-Installer/releases/download/spotify-installers/spotify_installer-1.2.85.519.g549a528b-x64.exe' };
  const stale = applyOfficial(entries, { watched: { 'windows-x64': { etag: '"new"' } }, builds: [build] });
  const entry = stale.find(e => e.id === '1.2.85.519.g549a528b-windows-x64');
  assert.equal(entry.sha256, 'a'.repeat(64));
  assert.deepEqual(entry.sources.map(s => s.label).sort(), ['GitHub archive', 'LoadSpot mirror', 'Spotify (current build)'], 'the permanent link stays on record once the ETag moved on');
  assert.ok(entry.sources.find(s => s.label === 'Spotify (current build)').expired, 'but as expired, never as the download');
  assert.equal(selectSource(entry).label, 'GitHub archive');
  const live = applyOfficial(entries, { watched: { 'windows-x64': { etag: '"old"' } }, builds: [build] });
  const current = live.find(e => e.id === '1.2.85.519.g549a528b-windows-x64');
  assert.equal(selectSource(current).label, 'Spotify (current build)');
  assert.equal(selectSource(current).etag, '"old"');
  const feed = windowsFeed(live)['1.2.85.519'].win.x64;
  assert.equal(feed.official, 'https://download.scdn.co/SpotifyFullSetupX64.exe');
  assert.equal(feed.etag, '"old"');
  assert.equal(feed.archive, build.archive);
  assert.equal(feed.sha256, build.sha256);
  assert.ok(feed.url.includes('loadspot'), 'the mirror stays the compatibility url');
  const fresh = applyOfficial(entries, { watched: {}, builds: [{ ...build, fullVersion: '1.3.9.1.gabcdef12', archive: undefined, etag: '"x"' }] });
  const added = fresh.find(e => e.id === '1.3.9.1.gabcdef12-windows-x64');
  assert.equal(added.date, '2026-03-13');
  assert.deepEqual(added.sources.map(s => [s.label, isExpired(s)]), [['Spotify (current build)', true]], 'a build with neither a live link nor an archive keeps only its record');
  assert.equal(windowsFeed(fresh)['1.3.9.1'], undefined, 'a build without any downloadable link is left out of the installer feed instead of breaking it');
  assert.equal(filterCatalog(fresh, { platform: 'windows', query: '1.3.9.1' }).length, 1, 'but stays visible in the library table');
  assert.deepEqual(windowsFeed([{ ...added, sources: [] }]), {}, 'and so is a build with no sources at all');
  const offered = applyOfficial(entries, { watched: {}, builds: [{ ...build, fullVersion: '1.3.9.1.gabcdef12', archive: undefined, etag: '"x"',
    updateService: { httpPrefix: 'https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.3.9.1.gabcdef12-77.exe', binaryHash: 'b'.repeat(40) } }] });
  const withPrefix = offered.find(e => e.id === '1.3.9.1.gabcdef12-windows-x64');
  assert.deepEqual(withPrefix.sources.map(s => s.label), ['Spotify (current build)', 'Spotify CDN'], "the update service's http_prefix is kept as Spotify's versioned link");
  assert.equal(windowsFeed(offered)['1.3.9.1'].win.x64.url, withPrefix.sources[1].url, 'the installer gets the official path and falls back from it');
  assert.equal(applyOfficial(entries, null), entries);
  assert.equal(applyOfficial(entries, { builds: [{ fullVersion: 'bad', sha256: 'x' }] }).length, entries.length);
});

let built = false;
try { await access(new URL('../site/dist/index.html', import.meta.url)); built = true; } catch {}
test('Built Pages APIs match source data and use the correct repository base path', { skip: !built }, async () => {
  const full = JSON.parse(await readFile(new URL('../site/dist/api/v1/catalog.json', import.meta.url), 'utf8'));
  const compact = JSON.parse(await readFile(new URL('../site/dist/api/v1/windows-x64.json', import.meta.url), 'utf8'));
  assert.deepEqual(full.entries, applyOfficial(catalog.entries, official));
  assert.deepEqual(full.official.watched, official.watched);
  assert.deepEqual(compact, windowsFeed(applyOfficial(catalog.entries, official)));
  const builtHtml = await readFile(new URL('../site/dist/index.html', import.meta.url), 'utf8');
  assert.ok(builtHtml.includes('data-api="/spotify-versions-history/api/v1/catalog.json"'));
  assert.ok(builtHtml.includes('href="/spotify-versions-history/favicon.svg"'));
});
