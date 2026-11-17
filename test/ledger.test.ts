import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ledgerFiles, readLedger, releasePath, writeLedger } from '../lib/ledger/io.ts';
import { RELEASE_SCHEMA_PATH, releaseJsonSchema } from '../lib/ledger/json-schema.ts';
import { fromLegacy, toLegacy } from '../lib/ledger/legacy.ts';
import { Release } from '../lib/ledger/schema.ts';
import type { LegacyCatalog, LegacyOfficial } from '../lib/v1/catalog.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const fixture = async (name: string) => JSON.parse(await readFile(here(`../testdata/v1/legacy/${name}`), 'utf8'));
const catalog: LegacyCatalog = await fixture('catalog.json');
const official: LegacyOfficial = await fixture('official.json');
const mobile: unknown = await fixture('mobile.json');

describe('ledger v2 from the v1 files', () => {
  const ledger = fromLegacy({ catalog, official, mobile });

  it('keeps every catalog entry as a listing and every watcher build as a capture', () => {
    const artifacts = ledger.releases.flatMap(release => release.artifacts);
    expect(ledger.releases.length).toBe(new Set(catalog.entries.map(entry => entry.fullVersion)).size);
    expect(artifacts.filter(artifact => artifact.listing).length).toBe(catalog.entries.length);
    expect(artifacts.flatMap(artifact => artifact.captures ?? []).length).toBe(official.builds.length);
  });

  it('gives back the same v1 inputs', () => {
    const back = toLegacy(ledger);
    expect(JSON.stringify(back.catalog)).toBe(JSON.stringify(catalog));
    expect(back.official).toEqual(official);
  });

  it('files each release by product and minor version', () => {
    expect(releasePath({ product: 'desktop', version: '1.3.10.2586', fullVersion: '1.3.10.2586.g81a118a22460' }))
      .toBe('desktop/1.3/1.3.10.2586.g81a118a22460.json');
    expect(releasePath({ product: 'ios', version: '9.2.0', fullVersion: '9.2.0' })).toBe('ios/9.2/9.2.0.json');
  });

  it('writes, reads back, and rewrites nothing when nothing changed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ledger-test-'));
    try {
      const first = await writeLedger(directory, ledger);
      expect(first.written.length).toBe(ledger.releases.length + 4);
      const reread = await readLedger(directory);
      expect([...ledgerFiles(reread)]).toEqual([...ledgerFiles(ledger)]);
      expect(await writeLedger(directory, reread)).toEqual({ written: [], removed: [] });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('matches the committed fixture ledger', async () => {
    const committed = await readLedger(here('../testdata/v1/ledger'));
    expect([...ledgerFiles(committed)]).toEqual([...ledgerFiles(ledger)]);
  });
});

describe('ledger v2 refuses what it cannot keep', () => {
  const entry = catalog.entries[0]!;

  it('an entry with a key v1 never wrote', () => {
    const withHash = { ...catalog, entries: [{ ...entry, sha256: 'a'.repeat(64) }] };
    expect(() => fromLegacy({ catalog: withHash, official: { builds: [] } })).toThrow(/key set/);
  });

  it('an entry whose id does not match its version, platform and architecture', () => {
    const wrongId = { ...catalog, entries: [{ ...entry, id: `${entry.fullVersion}-macos-arm64` }] };
    expect(() => fromLegacy({ catalog: wrongId, official: { builds: [] } })).toThrow(/id/);
  });

  it('a release whose artifact id does not follow fullVersion-platform-arch-format', () => {
    const release = fromLegacy({ catalog, official, mobile }).releases[0]!;
    const broken = { ...release, artifacts: [{ ...release.artifacts[0]!, id: 'something-else' }] };
    expect(() => Release.parse(broken)).toThrow();
  });
});

describe('committed JSON Schema', () => {
  it('is the one generated from lib/ledger/schema.ts (npm run ledger:schema)', async () => {
    expect(await readFile(here(`../${RELEASE_SCHEMA_PATH}`), 'utf8')).toBe(releaseJsonSchema());
  });
});
