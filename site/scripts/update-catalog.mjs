import { readFile, writeFile } from 'node:fs/promises';
import { LIVE_CATALOG, LEGACY_CATALOG, LINUX_PACKAGES, TESTED_VERSION, normalizeCatalog, parseLinuxPackages, mergeCatalogs } from '../src/lib/catalog.mjs';

const target = new URL('../data/catalog.json', import.meta.url);
async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 4_000_000) throw new Error(`Oversized catalog: ${url}`);
  return text;
}
const [live, legacy, linux] = await Promise.all([
  fetchText(LIVE_CATALOG).then(JSON.parse).then(normalizeCatalog),
  fetchText(LEGACY_CATALOG).then(JSON.parse).then(normalizeCatalog),
  fetchText(LINUX_PACKAGES).then(parseLinuxPackages),
]);
// A schema change or outage must never publish an empty or truncated catalog.
if (live.length < 200 || legacy.length < 200 || linux.length === 0 || !live.some(entry => entry.tested))
  throw new Error('Upstream catalog is incomplete; retaining the published snapshot.');
let previous;
try { previous = JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const entries = mergeCatalogs(previous?.entries ?? [], legacy, live, linux);
if (JSON.stringify(previous?.entries) === JSON.stringify(entries)) {
  console.log(`Catalog unchanged (${entries.length} installers); no deployment needed.`);
} else {
  const catalog = { schemaVersion: 1, updatedAt: new Date().toISOString(), testedVersion: TESTED_VERSION,
    upstream: [LIVE_CATALOG, LEGACY_CATALOG, LINUX_PACKAGES], entries };
  await writeFile(target, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`Updated catalog: ${entries.length} installers, ${new Set(entries.map(entry => entry.version)).size} versions.`);
}
