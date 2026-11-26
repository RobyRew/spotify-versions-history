/**
 * Loads what the site shows and keeps it in memory, refreshed in the background every ten minutes
 * (a request never waits on a refresh once a first copy exists).
 *
 * Where each input comes from, by environment variable:
 *  - the ledger: LEDGER_DIR (ledger files, lib/ledger/io.ts) or, until those are committed, the v1
 *    data files converted with fromLegacy: from LEGACY_DATA_URL (a base URL; production reads the
 *    repository's site/data on main, which the release watcher keeps current) and, when that cannot
 *    be read, from LEGACY_DATA_DIR (default ../site/data; the image carries the copy it was built with);
 *  - link health: HEALTH_URL or HEALTH_FILE (default .data/health.json), as sensors/health.ts writes it;
 *  - verification: VERIFICATION_URL or VERIFICATION_FILE (default .data/verification.json), the merged
 *    report sensors/verify.ts merge writes. `node scripts/fetch-data.mjs` downloads both from CI.
 * Health and verification are optional: without them the pages say so and offer every link not known
 * to be dead.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readLedger } from '../../../lib/ledger/io.ts';
import { fromLegacy } from '../../../lib/ledger/legacy.ts';
import type { Ledger, MobileState } from '../../../lib/ledger/schema.ts';
import type { LegacyCatalog, LegacyOfficial } from '../../../lib/v1/catalog.ts';
import { HealthFile } from '../../../sensors/health/schema.ts';
import type { MergedReport } from '../../../sensors/verify/report.ts';
import { releaseViews, type ReleaseView } from '../../../lib/site/model.ts';
import type { MobileHistory } from '../../../sensors/mobile.ts';

const REFRESH_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;

/** The fields of a merged verification report the site reads. */
const Report = z.object({
  schema: z.literal(1),
  generatedAt: z.iso.datetime(),
  runs: z.array(z.string()),
  artifacts: z.array(z.object({
    key: z.string(), sensor: z.string(), version: z.string(), fullVersion: z.string().nullable(),
    platform: z.string(), arch: z.string(), format: z.string(), hosts: z.array(z.string()),
    size: z.number().nullable(), sha256: z.string().nullable(),
    level: z.enum(['signed', 'spotify-digest', 'store-digest', 'third-party-digest', 'unverified']),
    ok: z.boolean(), problems: z.array(z.string()), rotated: z.boolean(),
    checks: z.array(z.object({ id: z.string(), status: z.enum(['pass', 'fail', 'skip']), detail: z.string(), verifier: z.string(), host: z.string() }).loose()),
  }).loose()),
});

/** The newest finished run of one probe workflow, from GitHub's public API. */
export interface WorkflowRun {
  workflow: string;
  conclusion: string | null;
  startedAt: string;
  url: string;
}

export interface SiteData {
  releases: ReleaseView[];
  ledger: Ledger;
  mobile: MobileState | null;
  /** iOS versions and Android updates (sensors/mobile.ts), or null. */
  mobileHistory: MobileHistory | null;
  health: HealthFile | null;
  verification: MergedReport | null;
  /** The probe workflows' newest finished runs, by file name; empty when GitHub cannot be asked. */
  runs: Record<string, WorkflowRun>;
  loadedAt: string;
  /** Where each input came from, or why it is missing. */
  inputs: { ledger: string; health: string; verification: string };
}

const RUNS_REPO = process.env.GITHUB_RUNS_REPO ?? 'RobyRew/spotify-versions-history';
const PROBE_WORKFLOWS = ['watch-spotify.yml', 'health.yml', 'verify.yml', 'pages.yml'] as const;

/** The newest finished run of each probe workflow (4 unauthenticated calls per refresh: 24 an hour). */
async function loadRuns(): Promise<Record<string, WorkflowRun>> {
  if (RUNS_REPO === 'off') return {};
  const runs: Record<string, WorkflowRun> = {};
  await Promise.all(PROBE_WORKFLOWS.map(async workflow => {
    try {
      const response = await fetch(`https://api.github.com/repos/${RUNS_REPO}/actions/workflows/${workflow}/runs?branch=main&status=completed&per_page=1`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'spotify-versions-history-site' },
      });
      if (!response.ok) return;
      const run = ((await response.json()) as { workflow_runs?: { conclusion: string | null; run_started_at: string; html_url: string }[] }).workflow_runs?.[0];
      if (run) runs[workflow] = { workflow, conclusion: run.conclusion, startedAt: run.run_started_at, url: run.html_url };
    } catch {
      // GitHub unreachable or rate-limited: the probes page says the run is unknown.
    }
  }));
  return runs;
}

/** mobile-history.json from LEGACY_DATA_URL, else from LEGACY_DATA_DIR; null when neither has it. */
async function loadMobileHistory(): Promise<MobileHistory | null> {
  if (process.env.LEGACY_DATA_URL) {
    try {
      return (await readJsonUrl(new URL('mobile-history.json', process.env.LEGACY_DATA_URL.replace(/\/?$/, '/')).href)) as MobileHistory;
    } catch {
      // Fall through to the bundled copy.
    }
  }
  try {
    return (await readJsonFile(resolve(process.env.LEGACY_DATA_DIR ?? '../site/data', 'mobile-history.json'))) as MobileHistory;
  } catch {
    return null;
  }
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonUrl(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}

const LEGACY_FILES = ['catalog.json', 'official.json', 'mobile.json'] as const;

function legacyLedger([catalog, official, mobile]: unknown[]): Ledger {
  return fromLegacy({ catalog: catalog as LegacyCatalog, official: official as LegacyOfficial, mobile: mobile ?? null });
}

/** `fallback`: use the bundled copy when the URL fails (the first load); a refresh keeps the copy it has instead. */
async function loadLedger(fallback: boolean): Promise<{ ledger: Ledger; from: string }> {
  if (process.env.LEDGER_DIR) return { ledger: await readLedger(process.env.LEDGER_DIR), from: `ledger ${process.env.LEDGER_DIR}` };
  let urlProblem = '';
  if (process.env.LEGACY_DATA_URL) {
    const base = process.env.LEGACY_DATA_URL.replace(/\/?$/, '/');
    try {
      const files = await Promise.all(LEGACY_FILES.map(name => readJsonUrl(new URL(name, base).href)));
      return { ledger: legacyLedger(files), from: `site data ${base}` };
    } catch (error) {
      if (!fallback) throw error;
      urlProblem = ` (${base} failed: ${(error as Error).message.slice(0, 160)})`;
      console.error(`site data from ${base} failed, using the bundled copy: ${(error as Error).message}`);
    }
  }
  const directory = resolve(process.env.LEGACY_DATA_DIR ?? '../site/data');
  const files = await Promise.all(LEGACY_FILES.map(async name => {
    try { return await readJsonFile(resolve(directory, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && name === 'mobile.json') return null;
      throw error;
    }
  }));
  return { ledger: legacyLedger(files), from: `site data ${directory}${urlProblem}` };
}

/** An optional input: the parsed value, or null with the reason it is missing. */
async function optional<T>(url: string | undefined, file: string, parse: (value: unknown) => T): Promise<{ value: T | null; from: string }> {
  const where = url ?? resolve(file);
  try {
    return { value: parse(url ? await readJsonUrl(url) : await readJsonFile(where)), from: where };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, from: `none (${where} does not exist)` };
    return { value: null, from: `none (${where}: ${(error as Error).message.slice(0, 200)})` };
  }
}

async function load(fallback: boolean): Promise<SiteData> {
  const now = new Date();
  const [{ ledger, from }, health, verification, mobileHistory, runs] = await Promise.all([
    loadLedger(fallback),
    optional(process.env.HEALTH_URL, process.env.HEALTH_FILE ?? '.data/health.json', value => HealthFile.parse(value)),
    optional(process.env.VERIFICATION_URL, process.env.VERIFICATION_FILE ?? '.data/verification.json', value => Report.parse(value) as unknown as MergedReport),
    loadMobileHistory(),
    loadRuns(),
  ]);
  // A refresh that cannot read an optional input keeps the copy it already has.
  const keptHealth = health.value ?? cache?.data.health ?? null;
  const keptVerification = verification.value ?? cache?.data.verification ?? null;
  return {
    releases: releaseViews(ledger, keptHealth, keptVerification, now),
    ledger,
    mobile: ledger.sensors.mobile,
    mobileHistory: mobileHistory ?? cache?.data.mobileHistory ?? null,
    health: keptHealth,
    verification: keptVerification,
    runs: Object.keys(runs).length > 0 ? runs : (cache?.data.runs ?? {}),
    loadedAt: now.toISOString(),
    inputs: {
      ledger: from,
      health: health.value || !keptHealth ? health.from : `${cache?.data.inputs.health} (kept; ${health.from})`,
      verification: verification.value || !keptVerification ? verification.from : `${cache?.data.inputs.verification} (kept; ${verification.from})`,
    },
  };
}

let cache: { data: SiteData; at: number } | null = null;
let pending: Promise<SiteData> | null = null;

function refresh(): Promise<SiteData> {
  pending ??= load(cache === null)
    .then(data => { cache = { data, at: Date.now() }; return data; })
    .finally(() => { pending = null; });
  return pending;
}

/** The current data; a stale copy is served while a fresh one loads. */
export async function siteData(): Promise<SiteData> {
  if (!cache) return refresh();
  if (Date.now() - cache.at > REFRESH_MS) refresh().catch(error => console.error(`site data refresh failed: ${(error as Error).message}`));
  return cache.data;
}
