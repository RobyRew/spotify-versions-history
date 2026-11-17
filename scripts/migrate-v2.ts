/**
 * Converts the v1 data files into ledger v2. Kept in the repository so the conversion can be re-run
 * and reviewed: node scripts/migrate-v2.ts [--from site/data] [--out ledger]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { writeLedger } from '../lib/ledger/io.ts';
import { fromLegacy } from '../lib/ledger/legacy.ts';
import type { LegacyCatalog, LegacyOfficial } from '../lib/v1/catalog.ts';

const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } });
const from = values.from ?? 'site/data';
const out = values.out ?? 'ledger';

async function readJson(name: string): Promise<unknown> {
  try { return JSON.parse(await readFile(join(from, name), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const catalog = await readJson('catalog.json');
const official = await readJson('official.json');
if (!catalog || !official) throw new Error(`${from} needs catalog.json and official.json`);
const ledger = fromLegacy({ catalog: catalog as LegacyCatalog, official: official as LegacyOfficial, mobile: await readJson('mobile.json') });
const { written, removed } = await writeLedger(out, ledger);
const artifacts = ledger.releases.reduce((count, release) => count + release.artifacts.length, 0);
console.log(`Ledger v2 in ${out}: ${ledger.releases.length} releases, ${artifacts} artifacts; ${written.length} files written, ${removed.length} removed.`);
