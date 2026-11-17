// Builds the v1 golden fixtures in testdata/v1 from a subset of site/data, using the v1 generator
// (site/src/lib/catalog.mjs). Removed together with site/; the fixtures it wrote stay.
//
//   testdata/v1/legacy/    the subset in the v1 file format
//   testdata/v1/ledger/    the same subset as ledger v2 files
//   testdata/v1/expected/  api/v1/catalog.json and windows-x64.json as the v1 generator wrote them
//   testdata/v1/times.json the clock each expected pair was generated at
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as v1 from '../../site/src/lib/catalog.mjs';
import { writeLedger } from '../../lib/ledger/io.ts';
import { fromLegacy } from '../../lib/ledger/legacy.ts';

const root = new URL('../../testdata/v1/', import.meta.url);
const read = async name => JSON.parse(await readFile(new URL(`../../site/data/${name}`, import.meta.url), 'utf8'));
const catalog = await read('catalog.json');
const official = await read('official.json');
const mobile = await read('mobile.json');

// Every build the watcher recorded, the tested build, every apt-listed build, the newest and the
// oldest build, and one build that has both a bare Spotify CDN path and a LoadSpot copy.
const versions = new Set([...official.builds.map(build => build.fullVersion), v1.TESTED_VERSION]);
for (const entry of catalog.entries) if (entry.sources.some(source => source.label === 'Spotify repository')) versions.add(entry.fullVersion);
versions.add(catalog.entries[0].fullVersion);
versions.add(catalog.entries.at(-1).fullVersion);
const both = catalog.entries.find(entry => entry.sources.some(s => s.label === 'Spotify CDN') && entry.sources.some(s => s.label === 'LoadSpot mirror'));
if (both) versions.add(both.fullVersion);
const subset = { ...catalog, entries: catalog.entries.filter(entry => versions.has(entry.fullVersion)) };

await rm(root, { recursive: true, force: true });
await mkdir(new URL('legacy/', root), { recursive: true });
await writeFile(new URL('legacy/catalog.json', root), JSON.stringify(subset, null, 2) + '\n');
await writeFile(new URL('legacy/official.json', root), JSON.stringify(official, null, 2) + '\n');
await writeFile(new URL('legacy/mobile.json', root), JSON.stringify(mobile, null, 2) + '\n');

// "signed": the update-service links recorded on 2026-09-18 are valid; "expired": they are not.
const times = { signed: '2026-10-01T00:00:00.000Z', expired: '2026-11-17T00:00:00.000Z' };
await writeFile(new URL('times.json', root), JSON.stringify(times, null, 2) + '\n');
for (const [label, iso] of Object.entries(times)) {
  const entries = v1.applyOfficial(subset.entries, official, Date.parse(iso));
  const directory = new URL(`expected/${label}/`, root);
  await mkdir(directory, { recursive: true });
  await writeFile(new URL('catalog.json', directory), JSON.stringify({ ...subset, official: { watched: official.watched }, entries }));
  await writeFile(new URL('windows-x64.json', directory), JSON.stringify(v1.windowsFeed(entries)));
}

const ledger = fromLegacy({ catalog: subset, official, mobile });
await writeLedger(fileURLToPath(new URL('ledger/', root)), ledger);
console.log(`testdata/v1: ${subset.entries.length} entries over ${versions.size} versions, ${official.builds.length} builds, ${ledger.releases.length} ledger releases.`);
