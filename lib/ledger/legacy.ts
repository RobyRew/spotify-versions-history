/**
 * Converts between the v1 data files (site/data/catalog.json, official.json, mobile.json) and ledger v2.
 *
 * The conversion is lossless in both directions for everything the v1 feeds are generated from:
 * toLegacy(fromLegacy(files)) gives back the same catalog entries, in the same order and key order,
 * and the same watcher builds. Data that ledger v2 cannot represent exactly makes fromLegacy throw
 * instead of being dropped.
 */
import { compareEntries, TESTED_VERSION, type LegacyBuild, type LegacyCatalog, type LegacyOfficial, type V1Entry } from '../v1/catalog.ts';
import type { Platform } from '../v1/sources.ts';
import { numericVersion } from '../versions.ts';
import { canonicalRelease, compareReleases } from './order.ts';
import {
  artifactId, Capture, MobileState, PermanentUrlsState, Release, UpdateServiceState, UpstreamCatalogsState, validated,
  type Artifact, type Ledger,
} from './schema.ts';

const ENTRY_KEYS = ['id', 'version', 'fullVersion', 'platform', 'architecture', 'format', 'date', 'size', 'tested', 'sources'];
const SOURCE_KEYS = ['url', 'kind', 'label'];

export function isTested(fullVersion: string, platform: string, arch: string): boolean {
  return platform === 'windows' && arch === 'x64' && fullVersion.toLowerCase() === TESTED_VERSION;
}

/** The format v1 assumed for a watcher build that did not name one. */
function buildFormat(build: Pick<LegacyBuild, 'platform' | 'format'>): string {
  return build.format ?? (build.platform === 'macos' ? 'tbz' : build.platform === 'linux' ? 'deb' : 'exe');
}

function sameKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

export interface LegacyFiles {
  catalog: LegacyCatalog;
  official: LegacyOfficial;
  mobile?: unknown;
}

export function fromLegacy({ catalog, official, mobile }: LegacyFiles): Ledger {
  const releases = new Map<string, { product: 'desktop'; version: string; fullVersion: string; artifacts: Map<string, Artifact> }>();
  const artifactFor = (fullVersion: string, platform: string, arch: string, format: string): Artifact => {
    let release = releases.get(fullVersion);
    if (!release) releases.set(fullVersion, release = { product: 'desktop', version: numericVersion(fullVersion), fullVersion, artifacts: new Map() });
    const id = artifactId(fullVersion, platform, arch, format);
    let artifact = release.artifacts.get(id);
    if (!artifact) release.artifacts.set(id, artifact = { id, platform, arch, format } as Artifact);
    return artifact;
  };

  for (const entry of catalog.entries) {
    const where = `catalog entry ${entry.id}`;
    if (!sameKeys(entry, ENTRY_KEYS)) throw new Error(`${where}: keys ${Object.keys(entry).join(',')} are not the v1 key set`);
    if (entry.id !== `${entry.fullVersion}-${entry.platform}-${entry.architecture}`) throw new Error(`${where}: id does not follow fullVersion-platform-architecture`);
    if (entry.version !== numericVersion(entry.fullVersion)) throw new Error(`${where}: version ${entry.version} does not match ${entry.fullVersion}`);
    if (entry.tested !== isTested(entry.fullVersion, entry.platform, entry.architecture)) throw new Error(`${where}: tested flag disagrees with ${TESTED_VERSION}`);
    for (const source of entry.sources) if (!sameKeys(source, SOURCE_KEYS)) throw new Error(`${where}: source keys ${Object.keys(source).join(',')}`);
    const artifact = artifactFor(entry.fullVersion, entry.platform, entry.architecture, entry.format);
    if (artifact.listing) throw new Error(`${where}: listed twice`);
    artifact.listing = { date: entry.date, size: entry.size, sources: entry.sources.map(({ url, kind, label }) => ({ url, kind, label })) };
  }

  for (const build of official.builds) {
    const { fullVersion, platform, architecture, ...capture } = build;
    const artifact = artifactFor(fullVersion, platform, architecture, buildFormat(build));
    (artifact.captures ??= []).push(Capture.parse(capture));
  }

  const ledgerReleases = [...releases.values()]
    .map(({ artifacts, ...release }) => canonicalRelease(Release.parse({ schema: 2, ...release, artifacts: [...artifacts.values()] })))
    .sort(compareReleases);
  const { updateService } = official;
  return {
    releases: ledgerReleases,
    sensors: {
      upstreamCatalogs: validated(UpstreamCatalogsState, { schema: 1, updatedAt: catalog.updatedAt, testedVersion: catalog.testedVersion, upstream: catalog.upstream }),
      permanentUrls: validated(PermanentUrlsState, { schema: 1, watched: official.watched ?? {} }),
      updateService: updateService ? validated(UpdateServiceState, { schema: 1, ...updateService }) : null,
      mobile: mobile == null ? null : validated(MobileState, mobile),
    },
  };
}

/** Rebuilds the v1 inputs (catalog.json without its overlay, and official.json) from the ledger. */
export function toLegacy(ledger: Ledger): { catalog: LegacyCatalog; official: LegacyOfficial } {
  const entries: V1Entry[] = [];
  const builds: LegacyBuild[] = [];
  for (const release of ledger.releases) {
    if (release.product !== 'desktop') continue;
    for (const artifact of release.artifacts) {
      const platform = artifact.platform as Platform;
      if (artifact.listing) entries.push({
        id: `${release.fullVersion}-${platform}-${artifact.arch}`,
        version: release.version,
        fullVersion: release.fullVersion,
        platform,
        architecture: artifact.arch,
        format: artifact.format,
        date: artifact.listing.date,
        size: artifact.listing.size,
        tested: isTested(release.fullVersion, platform, artifact.arch),
        sources: artifact.listing.sources.map(({ url, kind, label }) => ({ url, kind, label })),
      });
      for (const capture of artifact.captures ?? []) builds.push({ fullVersion: release.fullVersion, platform, architecture: artifact.arch, ...capture });
    }
  }
  entries.sort(compareEntries);
  // The watcher keeps its builds newest first (applyObservations in the v1 watcher).
  builds.sort((a, b) => Date.parse(b.lastModified ?? '') - Date.parse(a.lastModified ?? '') || a.architecture.localeCompare(b.architecture));
  const { upstreamCatalogs, permanentUrls, updateService } = ledger.sensors;
  const service = updateService && Object.fromEntries(Object.entries(updateService).filter(([key]) => key !== 'schema'));
  return {
    catalog: { schemaVersion: 1, updatedAt: upstreamCatalogs.updatedAt, testedVersion: upstreamCatalogs.testedVersion, upstream: upstreamCatalogs.upstream, entries },
    official: { schemaVersion: 1, watched: permanentUrls.watched, ...(service ? { updateService: service } : {}), builds },
  };
}
