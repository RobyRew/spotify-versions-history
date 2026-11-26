/**
 * Checks the ledger's download links and writes the health file (sensors/health/check.ts).
 *
 *   node sensors/health.ts [--legacy site/data | --ledger ledger] [--previous health.json] --out health.json
 *        [--only spotify-current,loadspot] [--all] [--now <iso>] [--alerts alerts.json]
 *
 * Links being down is data, not a failure of the run: the exit code is 0 whenever the file was written.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readLedger } from '../lib/ledger/io.ts';
import { fromLegacy } from '../lib/ledger/legacy.ts';
import type { ArchiveRecord } from './storage/archive.ts';
import type { Ledger } from '../lib/ledger/schema.ts';
import type { LegacyCatalog, LegacyOfficial } from '../lib/v1/catalog.ts';
import { collectSources, healthAlerts, runHealth } from './health/check.ts';
import { HealthFile, PROVIDERS, type Provider } from './health/schema.ts';

const { values } = parseArgs({
  options: {
    legacy: { type: 'string' }, ledger: { type: 'string' }, previous: { type: 'string' }, out: { type: 'string' },
    only: { type: 'string' }, all: { type: 'boolean' }, now: { type: 'string' }, alerts: { type: 'string' },
  },
});
if (!values.out) throw new Error('--out is required');
const now = values.now ? new Date(values.now) : new Date();
if (!Number.isFinite(now.getTime())) throw new Error(`--now ${values.now} is not a time`);

async function readJson(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function loadLedger(): Promise<Ledger> {
  if (values.ledger) return readLedger(values.ledger);
  const directory = values.legacy ?? 'site/data';
  const [catalog, official, mobile] = await Promise.all(['catalog.json', 'official.json', 'mobile.json'].map(name => readJson(join(directory, name))));
  if (!catalog || !official) throw new Error(`${directory} needs catalog.json and official.json`);
  return fromLegacy({ catalog: catalog as LegacyCatalog, official: official as LegacyOfficial, mobile });
}

const only = values.only ? new Set(values.only.split(',').map(item => item.trim()) as Provider[]) : null;
for (const provider of only ?? []) if (!(PROVIDERS as readonly string[]).includes(provider)) throw new Error(`Unknown provider ${provider}`);
const previousRaw = values.previous ? await readJson(values.previous) : null;
const previous = previousRaw ? HealthFile.safeParse(previousRaw) : null;
if (previous && !previous.success) console.error(`${values.previous} does not match the health schema; starting from no previous results`);

// The archive's own copies (sensors/archive.ts) are checked like any other link.
const archive = values.ledger ? null : (await readJson(join(values.legacy ?? 'site/data', 'archive.json'))) as ArchiveRecord | null;
const refs = collectSources(await loadLedger(), archive);
const { file, checked } = await runHealth(fetch, refs, { now, previous: previous?.success ? previous.data : null, all: values.all ?? false, only });
await writeFile(values.out, JSON.stringify(file, null, 2) + '\n');
console.log(`${refs.size} links, ${checked} checked in this run`);
for (const [provider, counts] of Object.entries(file.summary)) {
  const line = Object.entries(counts).filter(([, count]) => count > 0).map(([status, count]) => `${status} ${count}`).join(', ');
  if (line) console.log(`  ${provider}: ${line}`);
}
if (values.alerts) await writeFile(values.alerts, JSON.stringify(healthAlerts(file, now), null, 2) + '\n');
