/**
 * Reads the App Store page, the iTunes lookup and the Google Play listing and adds what is new to
 * site/data/mobile-history.json (sensors/mobile.ts). The file is written only when it changes, so a
 * quiet run makes no commit. A source that cannot be read is skipped with a warning.
 *
 *   node sensors/mobile-history.ts [path]     (default site/data/mobile-history.json)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { getJson, getText } from './lib/http.ts';
import { APP_STORE_PAGE, appStoreHistory, ITUNES_LOOKUP, itunesCurrent, mergeMobileHistory, PLAY_PAGE, playReading, type MobileHistory, type MobileReadings } from './mobile.ts';

const target = process.argv[2] ?? 'site/data/mobile-history.json';
// The two store pages are public listings; they answer a browser's request with the data the parsers read.
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'accept-language': 'en-US,en;q=0.9' };

let previous: MobileHistory | null = null;
try {
  previous = JSON.parse(await readFile(target, 'utf8')) as MobileHistory;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

async function attempt<T>(label: string, work: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    console.warn(`${label}: ${(error as Error).message}`);
    return empty;
  }
}

const readings: MobileReadings = {
  appStore: await attempt('App Store page', async () => appStoreHistory(await getText(fetch, APP_STORE_PAGE, { headers: BROWSER })), []),
  itunes: await attempt('iTunes lookup', async () => itunesCurrent(await getJson(fetch, ITUNES_LOOKUP)), null),
  play: await attempt('Google Play listing', async () => playReading(await getText(fetch, PLAY_PAGE, { headers: BROWSER })), null),
};
if (readings.appStore.length === 0) console.warn('App Store page: no version history found');
if (!readings.play) console.warn('Google Play listing: no update time found');

const next = mergeMobileHistory(previous, readings, new Date());
if (next === previous) {
  console.log('Mobile history unchanged.');
} else {
  await writeFile(target, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`Mobile history: ${next.ios.versions.length} iOS versions (newest ${next.ios.versions[0]?.version ?? 'none'}), ${next.android.updates.length} Android updates (newest ${next.android.updates[0]?.updatedAt ?? 'none'}).`);
}
