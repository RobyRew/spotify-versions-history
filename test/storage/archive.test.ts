import { describe, expect, it } from 'vitest';
import { withArchive, type ArtifactView, type ReleaseView } from '../../lib/site/model.ts';
import { classify, collectSources } from '../../sensors/health/check.ts';
import { archiveFilename, copyUrl, emptyRecord, filesToArchive, FREE_TIER_CAP_BYTES, objectKey, recordEntry, storedBytes, withinCap, type ArchiveRecord } from '../../sensors/storage/archive.ts';
import type { MergedArtifact, MergedReport } from '../../sensors/verify/report.ts';

const SHA = (char: string) => char.repeat(64);
const merged = (key: string, overrides: Partial<MergedArtifact> = {}): MergedArtifact => ({
  key, sensor: 'windows', version: '1.3.10.2586', fullVersion: '1.3.10.2586.g81a118a22460', platform: 'windows', arch: 'x64', format: 'exe',
  hosts: ['linux', 'win32'], size: 161310152, sha256: SHA('a'), level: 'signed', ok: true, problems: [], rotated: false, checks: [], ...overrides,
} as MergedArtifact);
const report = (artifacts: MergedArtifact[]): MergedReport => ({ schema: 1, generatedAt: '2026-11-26T04:28:00Z', runs: [], artifacts });

describe('what to keep', () => {
  it('keeps builds that passed at the signed level and have no copy with that SHA-256', () => {
    const record: ArchiveRecord = emptyRecord('https://spotify-versions-files.x.workers.dev');
    const exe = merged('1.3.10.2586.g81a118a22460-windows-x64-exe');
    record.files['old'] = recordEntry(merged('old', { sha256: SHA('c') }), null, new Date());
    const wanted = filesToArchive(report([
      exe,
      merged('failing', { ok: false }),
      merged('hash-only', { level: 'store-digest' }),
      merged('no-hash', { sha256: null }),
      merged('old', { sha256: SHA('c') }),
      merged('old-rebuilt', { sha256: SHA('d') }),
    ]), record);
    expect(wanted.map(artifact => artifact.key)).toEqual(['1.3.10.2586.g81a118a22460-windows-x64-exe', 'old-rebuilt']);
  });

  it('never plans past the cap, newest builds first, counting what is stored', () => {
    const record = emptyRecord('https://x');
    record.files['stored'] = recordEntry(merged('stored', { size: 4_000_000_000 }), null, new Date());
    const { fit, over } = withinCap([
      merged('old', { version: '1.2.53.440', size: 3_000_000_000 }),
      merged('new', { version: '1.3.11.2657', size: 3_000_000_000 }),
      merged('newer-small', { version: '1.3.11.2657', size: 1_000_000_000 }),
    ], record, 9_000_000_000);
    expect(fit.map(artifact => artifact.key)).toEqual(['new', 'newer-small']);
    expect(over.map(artifact => artifact.key)).toEqual(['old']);
    expect(storedBytes(record)).toBe(4_000_000_000);
    expect(FREE_TIER_CAP_BYTES).toBeLessThan(10_000_000_000);
  });

  it('names copies by build and stores them under their hash', () => {
    const dmg = merged('1.3.10.2586-macos-arm64-dmg', { fullVersion: null, platform: 'macos', arch: 'arm64', format: 'dmg', sha256: SHA('b') });
    expect(archiveFilename(dmg)).toBe('spotify-1.3.10.2586-macos-arm64.dmg');
    expect(objectKey(SHA('b'), archiveFilename(dmg))).toBe(`sha256/${SHA('b')}/spotify-1.3.10.2586-macos-arm64.dmg`);
    const entry = recordEntry(dmg, 'https://download.scdn.co/SpotifyARM64.dmg', new Date('2026-11-26T05:00:00Z'));
    expect(copyUrl('https://spotify-versions-files.x.workers.dev/', entry)).toBe(`https://spotify-versions-files.x.workers.dev/sha256/${SHA('b')}/spotify-1.3.10.2586-macos-arm64.dmg`);
    expect(classify(copyUrl('https://spotify-versions-files.x.workers.dev', entry))).toBe('github-archive');
    expect(classify('https://spotify-versions-files.x.workers.dev/other')).toBe('other');
  });
});

describe('copies on the site', () => {
  const mirror = { url: 'https://loadspot.amd64fox1.workers.dev/download/x.exe', label: 'LoadSpot mirror', kind: 'mirror', provider: 'loadspot', state: 'ok', usable: true, detail: '', checkedAt: null } as const;
  const exeView: ArtifactView = {
    id: '1.3.10.2586.g81a118a22460-windows-x64-exe', platform: 'windows', arch: 'x64', format: 'exe', size: 161310152, date: '2026-11-13',
    sha256: null, sha1: null, sources: [{ ...mirror }], best: { ...mirror }, verification: null,
  };
  const release: ReleaseView = { product: 'desktop', version: '1.3.10.2586', fullVersion: '1.3.10.2586.g81a118a22460', date: '2026-11-13', artifacts: [exeView], platforms: ['windows'], signed: false, downloadable: true };
  const record: ArchiveRecord = {
    schemaVersion: 1, base: 'https://spotify-versions-files.x.workers.dev',
    files: {
      [exeView.id]: recordEntry(merged(exeView.id), null, new Date('2026-11-26T05:00:00Z')),
      '1.3.10.2586-macos-arm64-dmg': recordEntry(merged('1.3.10.2586-macos-arm64-dmg', { fullVersion: null, platform: 'macos', arch: 'arm64', format: 'dmg', sha256: SHA('b') }), null, new Date('2026-11-26T05:00:00Z')),
      'elsewhere': recordEntry(merged('elsewhere', { version: '9.9.9.9', fullVersion: '9.9.9.9.gabc' }), null, new Date()),
    },
  };

  it('adds the copy as a link ranked before the mirror, and new files for builds the ledger does not list', () => {
    const [view] = withArchive([release], record, null, null);
    const exe = view!.artifacts.find(artifact => artifact.id === exeView.id)!;
    expect(exe.sources.map(source => source.label)).toEqual(['Archive copy', 'LoadSpot mirror']);
    expect(exe.best?.label).toBe('Archive copy');
    expect(exe.sha256).toBe(SHA('a'));
    const dmg = view!.artifacts.find(artifact => artifact.id === '1.3.10.2586-macos-arm64-dmg')!;
    expect(dmg).toMatchObject({ platform: 'macos', format: 'dmg', sha256: SHA('b') });
    expect(dmg.best?.url).toBe(`https://spotify-versions-files.x.workers.dev/sha256/${SHA('b')}/spotify-1.3.10.2586-macos-arm64.dmg`);
    expect(view!.platforms).toEqual(['windows', 'macos']);
    expect(release.artifacts[0]!.sources).toHaveLength(1);
  });

  it('gives link health the copies to check, with their sizes', () => {
    const refs = collectSources({ releases: [], sensors: {} } as never, record);
    const exeUrl = copyUrl(record.base!, record.files[exeView.id]!);
    expect(refs.get(exeUrl)).toEqual({ url: exeUrl, provider: 'github-archive', expectedSize: 161310152, expectedEtag: null });
    expect(collectSources({ releases: [], sensors: {} } as never, { ...record, base: null }).size).toBe(0);
  });

  it('changes nothing without a record or an origin', () => {
    expect(withArchive([release], null, null, null)[0]).toBe(release);
    expect(withArchive([release], { ...record, base: null }, null, null)[0]).toBe(release);
    expect(withArchive([release], { ...record, base: null }, null, null, 'https://spotify-versions-files.y.workers.dev')[0]!.artifacts).toHaveLength(2);
  });
});
