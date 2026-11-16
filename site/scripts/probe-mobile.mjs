import { readFile, writeFile } from 'node:fs/promises';
import { ITUNES_URL, STORE_URL, parseItunesLookup, parseStoreProduct } from '../src/lib/mobile.mjs';

const target = new URL('../data/mobile.json', import.meta.url);

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

let previous = null;
try { previous = JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const next = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  ios: previous?.ios ?? null,
  windowsStore: previous?.windowsStore ?? null,
  android: {
    status: 'no-public-installer',
    detail: 'The Play build is delivered by Google Play. A Spotify CDN URL is recorded only after a capture on a device shows one. See docs/ANDROID_UPDATE.md.',
  },
};

try { next.ios = parseItunesLookup(await getJson(ITUNES_URL)) ?? next.ios; }
catch (error) { console.warn(error.message); }
try { next.windowsStore = parseStoreProduct(await getJson(STORE_URL)) ?? next.windowsStore; }
catch (error) { console.warn(error.message); }

const stable = (value) => JSON.stringify({ ...value, checkedAt: null });
if (previous && stable(previous) === stable(next)) console.log('Mobile version sensors unchanged.');
else {
  await writeFile(target, JSON.stringify(next, null, 2) + '\n');
  console.log(`Mobile sensors: iOS ${next.ios?.version ?? 'unknown'}, Store update ${next.windowsStore?.lastUpdate ?? 'unknown'}.`);
}
