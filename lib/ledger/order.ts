/** Fixed key and file order for the ledger, so a run that learns nothing new writes identical bytes. */
import { compareVersions } from '../versions.ts';
import { ARCHES, FORMATS, PLATFORMS, PRODUCTS, type Artifact, type Capture, type Listing, type Release } from './schema.ts';

function ordered<T extends object>(value: T, keys: readonly (keyof T)[]): T {
  const out: Partial<T> = {};
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (!keys.includes(key) && value[key] !== undefined) throw new Error(`Unexpected key "${String(key)}"`);
  }
  return out as T;
}

function canonicalListing(listing: Listing): Listing {
  return ordered({ ...listing, sources: listing.sources.map(source => ordered(source, ['url', 'kind', 'label'])) }, ['date', 'size', 'sources']);
}

function canonicalCapture(capture: Capture): Capture {
  const updateService = capture.updateService && ordered(capture.updateService, ['httpPrefix', 'binaryHash', 'targetVersion', 'seenAt', 'signedUrl', 'signedUntil']);
  return ordered({ ...capture, updateService }, ['sha256', 'sha1', 'size', 'lastModified', 'capturedAt', 'url', 'etag', 'sensors', 'format',
    'verified', 'conflict', 'updateService', 'archive', 'archivedFrom']);
}

export function compareArtifacts(a: Pick<Artifact, 'platform' | 'arch' | 'format'>, b: Pick<Artifact, 'platform' | 'arch' | 'format'>): number {
  return PLATFORMS.indexOf(a.platform) - PLATFORMS.indexOf(b.platform) ||
    ARCHES.indexOf(a.arch) - ARCHES.indexOf(b.arch) || FORMATS.indexOf(a.format) - FORMATS.indexOf(b.format);
}

/** Product, then newest version first. */
export function compareReleases(a: Pick<Release, 'product' | 'version' | 'fullVersion'>, b: Pick<Release, 'product' | 'version' | 'fullVersion'>): number {
  return PRODUCTS.indexOf(a.product) - PRODUCTS.indexOf(b.product) || compareVersions(b.version, a.version) || a.fullVersion.localeCompare(b.fullVersion);
}

export function canonicalRelease(release: Release): Release {
  const artifacts = release.artifacts.toSorted(compareArtifacts).map(artifact => ordered({
    ...artifact,
    listing: artifact.listing && canonicalListing(artifact.listing),
    captures: artifact.captures?.map(canonicalCapture),
  }, ['id', 'platform', 'arch', 'format', 'listing', 'captures']));
  return ordered({ ...release, artifacts }, ['schema', 'product', 'version', 'fullVersion', 'artifacts']);
}
