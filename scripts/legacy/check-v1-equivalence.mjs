// Transition check, removed together with site/. On the full site/data it asserts that:
//  1. site/data -> ledger v2 files on disk -> site/data loses nothing (catalog byte for byte, watcher
//     builds field for field);
//  2. the v1 files generated from the ledger (lib/v1/feeds.ts) equal, byte for byte, what the v1
//     generator (site/src/lib/catalog.mjs as called by site/src/pages/api/v1/*.json.ts) produces,
//     once at a time when the recorded signed links were valid and once now.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v1 from '../../site/src/lib/catalog.mjs';
import { readLedger, writeLedger } from '../../lib/ledger/io.ts';
import { fromLegacy, toLegacy } from '../../lib/ledger/legacy.ts';
import { buildV1 } from '../../lib/v1/feeds.ts';

const read = async name => JSON.parse(await readFile(new URL(`../../site/data/${name}`, import.meta.url), 'utf8'));
const catalog = await read('catalog.json');
const official = await read('official.json');
const mobile = await read('mobile.json');

const directory = await mkdtemp(join(tmpdir(), 'ledger-v2-'));
try {
  const { written } = await writeLedger(directory, fromLegacy({ catalog, official, mobile }));
  const ledger = await readLedger(directory);

  const back = toLegacy(ledger);
  assert.equal(JSON.stringify(back.catalog), JSON.stringify(catalog), 'catalog.json does not survive the round trip');
  assert.deepEqual(back.official, official, 'official.json does not survive the round trip');

  const times = { signed: Date.parse('2026-10-01T00:00:00.000Z'), now: Date.now() };
  for (const [label, now] of Object.entries(times)) {
    const entries = v1.applyOfficial(catalog.entries, official, now);
    const expected = {
      catalog: JSON.stringify({ ...catalog, official: { watched: official.watched }, entries }),
      windowsX64: JSON.stringify(v1.windowsFeed(entries)),
    };
    const actual = buildV1(ledger, now);
    assert.equal(actual.catalog, expected.catalog, `api/v1/catalog.json differs (${label})`);
    assert.equal(actual.windowsX64, expected.windowsX64, `api/v1/windows-x64.json differs (${label})`);
    console.log(`${label}: catalog.json ${actual.catalog.length} bytes and windows-x64.json ${actual.windowsX64.length} bytes are identical`);
  }
  const artifacts = ledger.releases.reduce((count, release) => count + release.artifacts.length, 0);
  console.log(`Round trip through ${written.length} ledger files (${ledger.releases.length} releases, ${artifacts} artifacts) kept ${catalog.entries.length} entries and ${official.builds.length} builds.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
