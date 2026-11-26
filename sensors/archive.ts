/**
 * Keeps a copy of every checked build in R2 (sensors/storage/archive.ts decides which):
 *
 *   node sensors/archive.ts --merged merged.json --detections detections.json \
 *        --record site/data/archive.json [--base <files Worker origin>] [--work <dir>] [--dry-run]
 *
 * Builds the record already holds are skipped without a download. Before anything is planned or
 * fetched, the bucket is listed (measure() in sensors/storage/r2.ts); when the listing fails, nothing
 * is fetched or stored and the run exits 1. The larger of the listed total and the record's total
 * counts as stored, and builds are planned newest first while that plus the build stays at or under
 * the cap (FREE_TIER_CAP_BYTES, 9 GB; ARCHIVE_MAX_BYTES can only lower it); the others are skipped
 * and named. The planned builds are fetched again through the verify pipeline (so the Store's signed
 * links and the retries apply), each file's SHA-256 must equal the merged report's, and the object is
 * written only when the bucket does not have it. The R2 client refuses requests past the run's budget
 * (RUN_BUDGET) and writes past the cap. The record is rewritten only when it changes. Needs
 * CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (not with --dry-run, which plans
 * from the record alone); the base comes from --base, ARCHIVE_FILES_URL or the record.
 */
import { createHash } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadTrust } from '../lib/trust.ts';
import { artifactId } from '../lib/ledger/schema.ts';
import { archiveFilename, capFromEnv, countedBytes, emptyRecord, filesToArchive, recordEntry, storedBytes, withinCap, type ArchiveRecord } from './storage/archive.ts';
import { r2Client, r2ConfigFromEnv, type R2Client } from './storage/r2.ts';
import type { Detection } from './types.ts';
import { runPipeline } from './verify/pipeline.ts';
import type { MergedReport } from './verify/report.ts';

const { values } = parseArgs({
  options: {
    merged: { type: 'string' },
    detections: { type: 'string' },
    record: { type: 'string' },
    base: { type: 'string' },
    work: { type: 'string' },
    'dry-run': { type: 'boolean' },
  },
});
if (!values.merged || !values.detections || !values.record) throw new Error('archive needs --merged, --detections and --record');
const dryRun = values['dry-run'] ?? false;
const now = new Date();

const merged = JSON.parse(await readFile(values.merged, 'utf8')) as MergedReport;
let record: ArchiveRecord;
try {
  record = JSON.parse(await readFile(values.record, 'utf8')) as ArchiveRecord;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  record = emptyRecord();
}
const before = JSON.stringify(record);
const base = values.base ?? process.env.ARCHIVE_FILES_URL ?? record.base;
if (!base) throw new Error('No files Worker origin: pass --base or set ARCHIVE_FILES_URL');
record.base = base.replace(/\/+$/, '');

// R2's free tier: the cap can only be lowered, and the bucket is measured before anything is planned
// or fetched. Without a measurement nothing is stored.
const capBytes = capFromEnv(process.env.ARCHIVE_MAX_BYTES);
const candidates = filesToArchive(merged, record);
const recorded = storedBytes(record);
const gb = (bytes: number) => (bytes / 1e9).toFixed(2);
let r2: R2Client | null = null;
let listed: { objects: number; bytes: number } | null = null;
if (!dryRun) {
  const config = r2ConfigFromEnv();
  if (!config && candidates.length > 0) throw new Error('R2 is not configured: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY');
  if (config) {
    r2 = r2Client(config, { capBytes, knownBytes: recorded });
    try {
      listed = await r2.measure();
      console.log(`The bucket holds ${listed.objects} object(s), ${gb(listed.bytes)} GB; the record lists ${Object.keys(record.files).length} file(s), ${gb(recorded)} GB.`);
    } catch (error) {
      console.error(`The bucket was not measured, so nothing is fetched or stored: ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

const stored = countedBytes(listed?.bytes ?? 0, record);
const { fit: wanted, over } = withinCap(candidates, stored, capBytes);
console.log(`${merged.artifacts.length} checked build(s); ${candidates.length} without a copy yet; ${gb(stored)} GB counted as stored of the ${gb(capBytes)} GB cap${listed ? '' : ' (from the record: the bucket was not measured)'}`);
// The plan is listed when it can be acted on: on a dry run, or after the bucket was measured.
if (dryRun || listed) {
  for (const artifact of wanted) console.log(`  ${artifact.key} → ${archiveFilename(artifact)} (${artifact.size} bytes)`);
  for (const artifact of over) console.warn(`  ${artifact.key}: skipped, it would pass the ${gb(capBytes)} GB cap`);
}

if (wanted.length > 0 && r2 && listed) {
  const file = JSON.parse(await readFile(values.detections, 'utf8')) as { results: { detections?: Detection[] }[] };
  const keys = new Set(wanted.map(artifact => artifact.key));
  const detections = file.results.flatMap(result => result.detections ?? []).filter(detection => keys.has(artifactId(detection.fullVersion ?? detection.version, detection.platform, detection.arch, detection.format)));
  const workDirectory = values.work ?? join(tmpdir(), 'svh-archive');
  const fetched = await runPipeline(detections, {
    fetch, trust: await loadTrust(), now, workDirectory, keepFiles: true,
    only: new Set(wanted.map(artifact => artifact.sensor)),
    log: message => console.log(message),
  });
  for (const artifact of wanted) {
    const path = join(workDirectory, `${artifact.key}.${artifact.format}`);
    const host = fetched.artifacts.find(candidate => candidate.key === artifact.key);
    try {
      if (!host?.file) throw new Error(host?.error ?? 'not fetched again (no detection for it today)');
      const bytes = new Uint8Array(await readFile(path));
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== artifact.sha256) throw new Error(`the file fetched now has SHA-256 ${sha256}, the checked one ${artifact.sha256}`);
      const entry = recordEntry(artifact, host.source?.url ?? null, now);
      const present = await r2.head(entry.object);
      if (present && present.size !== entry.size) throw new Error(`the bucket has ${entry.object} with ${present.size} bytes, not ${entry.size}`);
      if (!present) {
        await r2.put(entry.object, bytes, { sha256, contentType: 'application/octet-stream', contentDisposition: `attachment; filename="${archiveFilename(artifact)}"` });
        console.log(`stored ${entry.object}`);
      } else {
        console.log(`already in the bucket: ${entry.object}`);
      }
      record.files[artifact.key] = entry;
    } catch (error) {
      console.error(`${artifact.key}: not stored: ${(error as Error).message}`);
      process.exitCode = 1;
    } finally {
      await rm(path, { force: true });
    }
  }
}
if (r2) {
  const { requests, written } = r2.usage();
  console.log(`R2 requests this run: ${requests.A} Class A of ${r2.budget.limits.A}, ${requests.B} Class B of ${r2.budget.limits.B}; ${gb(written)} GB written.`);
}

// Keys sorted, so the committed file changes only where a copy was added.
const sorted: ArchiveRecord = { schemaVersion: 1, base: record.base, files: Object.fromEntries(Object.entries(record.files).sort(([a], [b]) => a.localeCompare(b))) };
if (JSON.stringify(sorted) === before) console.log('Archive record unchanged.');
else if (dryRun) console.log('(dry run: record not written)');
else {
  await writeFile(values.record, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`Archive record: ${Object.keys(sorted.files).length} file(s).`);
}
