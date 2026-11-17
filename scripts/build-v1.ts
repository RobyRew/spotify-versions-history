/**
 * Writes api/v1/catalog.json and api/v1/windows-x64.json from the ledger:
 * node scripts/build-v1.ts [--ledger ledger] [--out dist-api] [--now 2026-11-17T00:00:00Z]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readLedger } from '../lib/ledger/io.ts';
import { buildV1 } from '../lib/v1/feeds.ts';

const { values } = parseArgs({ options: { ledger: { type: 'string' }, out: { type: 'string' }, now: { type: 'string' } } });
const now = values.now ? Date.parse(values.now) : Date.now();
if (!Number.isFinite(now)) throw new Error(`--now ${values.now} is not a date`);
const files = buildV1(await readLedger(values.ledger ?? 'ledger'), now);
const directory = join(values.out ?? 'dist-api', 'api', 'v1');
await mkdir(directory, { recursive: true });
await writeFile(join(directory, 'catalog.json'), files.catalog);
await writeFile(join(directory, 'windows-x64.json'), files.windowsX64);
console.log(`Wrote ${join(directory, 'catalog.json')} (${files.catalog.length} bytes) and windows-x64.json (${files.windowsX64.length} bytes).`);
