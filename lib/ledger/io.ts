/** Reads and writes the ledger directory: ledger/<product>/<major.minor>/<fullVersion>.json plus ledger/sensors/*.json. */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { canonicalRelease, compareReleases } from './order.ts';
import { MobileState, PermanentUrlsState, PRODUCTS, Release, UpdateServiceState, UpstreamCatalogsState, validated, type Ledger } from './schema.ts';

export const SENSOR_FILES = {
  upstreamCatalogs: 'sensors/upstream-catalogs.json',
  permanentUrls: 'sensors/permanent-urls.json',
  updateService: 'sensors/update-service.json',
  mobile: 'sensors/mobile.json',
} as const;

export function releasePath(release: Pick<Release, 'product' | 'version' | 'fullVersion'>): string {
  const [major, minor = '0'] = release.version.split('.');
  return `${release.product}/${major}.${minor}/${release.fullVersion}.json`;
}

/** Two-space JSON with a trailing newline, keys in the ledger's fixed order. */
export function serializeRelease(release: Release): string {
  return JSON.stringify(canonicalRelease(release), null, 2) + '\n';
}

export function serializeState(state: unknown): string {
  return JSON.stringify(state, null, 2) + '\n';
}

/** Every file the ledger consists of, keyed by its path relative to the ledger root. */
export function ledgerFiles(ledger: Ledger): Map<string, string> {
  const files = new Map<string, string>();
  for (const release of ledger.releases) {
    const path = releasePath(release);
    if (files.has(path)) throw new Error(`Two releases map to ${path}`);
    files.set(path, serializeRelease(release));
  }
  for (const [key, path] of Object.entries(SENSOR_FILES) as [keyof Ledger['sensors'], string][]) {
    const state = ledger.sensors[key];
    if (state) files.set(path, serializeState(state));
  }
  return files;
}

async function readOptional(path: string): Promise<unknown> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function listJson(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { recursive: true })).filter(name => name.endsWith('.json')).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

export async function readLedger(root: string): Promise<Ledger> {
  const releases: Release[] = [];
  for (const product of PRODUCTS) {
    for (const name of await listJson(join(root, product))) {
      const relativePath = `${product}/${name.split('\\').join('/')}`;
      const release = Release.parse(JSON.parse(await readFile(join(root, relativePath), 'utf8')));
      if (releasePath(release) !== relativePath) throw new Error(`${relativePath} belongs at ${releasePath(release)}`);
      releases.push(release);
    }
  }
  releases.sort(compareReleases);
  const upstreamCatalogs = await readOptional(join(root, SENSOR_FILES.upstreamCatalogs));
  const permanentUrls = await readOptional(join(root, SENSOR_FILES.permanentUrls));
  const updateService = await readOptional(join(root, SENSOR_FILES.updateService));
  const mobile = await readOptional(join(root, SENSOR_FILES.mobile));
  return {
    releases,
    sensors: {
      upstreamCatalogs: validated(UpstreamCatalogsState, upstreamCatalogs),
      permanentUrls: validated(PermanentUrlsState, permanentUrls),
      updateService: updateService === null ? null : validated(UpdateServiceState, updateService),
      mobile: mobile === null ? null : validated(MobileState, mobile),
    },
  };
}

/** Writes changed files only and removes release files the ledger no longer has. */
export async function writeLedger(root: string, ledger: Ledger): Promise<{ written: string[]; removed: string[] }> {
  const files = ledgerFiles(ledger);
  const written: string[] = [];
  for (const [path, content] of files) {
    const target = join(root, path);
    if ((await readFile(target, 'utf8').catch(() => null)) === content) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(path);
  }
  const removed: string[] = [];
  for (const product of PRODUCTS) {
    for (const name of await listJson(join(root, product))) {
      const path = `${product}/${name.split('\\').join('/')}`;
      if (files.has(path)) continue;
      await rm(join(root, path));
      removed.push(path);
    }
  }
  return { written, removed };
}
