/**
 * Ledger v2: the archive's source of truth, one JSON file per release under ledger/<product>/.
 *
 * A release lists its artifacts (one per platform, architecture and file format). Each artifact keeps
 * the evidence apart instead of merging it:
 *  - `listing`: what an upstream catalog said about the build (LoadSpot, the archived LoaderSpot
 *    table, Spotify's apt index): its date, size and download links;
 *  - `captures`: what this repository's own sensors downloaded and hashed, keyed by SHA-256.
 * Views (the API, the site, the v1 feeds) are derived from that evidence and never written back.
 */
import { z } from 'zod';
import { FULL_VERSION, numericVersion } from '../versions.ts';

export const PRODUCTS = ['desktop', 'android', 'ios'] as const;
export const PLATFORMS = ['windows', 'macos', 'linux', 'windows-store', 'android', 'ios'] as const;
export const ARCHES = ['x64', 'arm64', 'x86', 'universal'] as const;
export const FORMATS = ['exe', 'tbz', 'dmg', 'zip', 'deb', 'snap', 'msix', 'msixbundle', 'appx', 'appxbundle', 'apk', 'apks'] as const;

const instant = z.iso.datetime();
const httpsUrl = z.url({ protocol: /^https$/ });
const hex = (length: number) => z.string().regex(new RegExp(`^[0-9a-fA-F]{${length}}$`));

export const ListingSource = z.strictObject({
  url: httpsUrl,
  kind: z.enum(['official', 'archive', 'mirror']),
  label: z.string().min(1),
});

export const Listing = z.strictObject({
  date: z.iso.date().nullable(),
  size: z.int().positive().nullable(),
  sources: z.array(ListingSource).min(1),
});

/** What Spotify's desktop update service said about this build when it offered it. */
export const UpdateServiceSighting = z.strictObject({
  httpPrefix: httpsUrl,
  binaryHash: hex(40).nullable().optional(),
  targetVersion: z.int().optional(),
  seenAt: instant,
  signedUrl: httpsUrl.optional(),
  signedUntil: instant.optional(),
});

/** One download of the artifact by a sensor of this repository. */
export const Capture = z.strictObject({
  sha256: hex(64),
  sha1: hex(40).optional(),
  size: z.int().positive().optional(),
  lastModified: instant.nullable().optional(),
  capturedAt: instant,
  url: httpsUrl,
  etag: z.string().nullable().optional(),
  sensors: z.array(z.string().min(1)).min(1),
  format: z.enum(FORMATS).optional(),
  verified: z.literal('binary_hash').optional(),
  conflict: z.string().optional(),
  updateService: UpdateServiceSighting.optional(),
  archive: httpsUrl.optional(),
  archivedFrom: z.string().optional(),
});

export const Artifact = z.strictObject({
  id: z.string().min(1),
  platform: z.enum(PLATFORMS),
  arch: z.enum(ARCHES),
  format: z.enum(FORMATS),
  listing: Listing.optional(),
  captures: z.array(Capture).min(1).optional(),
}).refine(artifact => artifact.listing !== undefined || artifact.captures !== undefined, {
  message: 'An artifact needs a listing or at least one capture',
});

export const Release = z.strictObject({
  schema: z.literal(2),
  product: z.enum(PRODUCTS),
  version: z.string().regex(/^\d{1,5}(\.\d{1,8}){1,3}$/),
  fullVersion: z.string().min(1),
  artifacts: z.array(Artifact),
}).superRefine((release, ctx) => {
  if (release.product === 'desktop') {
    if (!FULL_VERSION.test(release.fullVersion)) ctx.addIssue({ code: 'custom', path: ['fullVersion'], message: 'not a desktop build version' });
    else if (numericVersion(release.fullVersion) !== release.version) ctx.addIssue({ code: 'custom', path: ['version'], message: `expected ${numericVersion(release.fullVersion)}` });
  }
  const seen = new Set<string>();
  release.artifacts.forEach((artifact, index) => {
    const expected = artifactId(release.fullVersion, artifact.platform, artifact.arch, artifact.format);
    if (artifact.id !== expected) ctx.addIssue({ code: 'custom', path: ['artifacts', index, 'id'], message: `expected ${expected}` });
    if (seen.has(artifact.id)) ctx.addIssue({ code: 'custom', path: ['artifacts', index, 'id'], message: 'duplicate artifact' });
    seen.add(artifact.id);
  });
});

export function artifactId(fullVersion: string, platform: string, arch: string, format: string): string {
  return `${fullVersion}-${platform}-${arch}-${format}`;
}

/** The catalog sources the listings came from, and when they last changed (ledger/sensors/upstream-catalogs.json). */
export const UpstreamCatalogsState = z.strictObject({
  schema: z.literal(1),
  updatedAt: instant,
  testedVersion: z.string(),
  upstream: z.array(httpsUrl),
});

/** Last reading of each permanent Spotify URL (ledger/sensors/permanent-urls.json). */
export const PermanentUrlsState = z.strictObject({
  schema: z.literal(1),
  watched: z.record(z.string(), z.looseObject({ etag: z.string().nullable().optional() })),
});

/** Last answer of the desktop update service per platform (ledger/sensors/update-service.json). */
export const UpdateServiceState = z.looseObject({
  schema: z.literal(1),
  offers: z.record(z.string(), z.looseObject({})),
});

/** iOS and Microsoft Store listing readings, kept as recorded until their own sensors replace them. */
export const MobileState = z.looseObject({
  schemaVersion: z.literal(1),
});

/**
 * Validates a sensor state and returns the value it was given, not zod's copy, so the state keeps its
 * key order byte for byte (permanent-url readings are copied into api/v1/catalog.json as they are).
 */
export function validated<T>(schema: z.ZodType<T>, value: unknown): T {
  schema.parse(value);
  return value as T;
}

export type ListingSource = z.infer<typeof ListingSource>;
export type Listing = z.infer<typeof Listing>;
export type UpdateServiceSighting = z.infer<typeof UpdateServiceSighting>;
export type Capture = z.infer<typeof Capture>;
export type Artifact = z.infer<typeof Artifact>;
export type Release = z.infer<typeof Release>;
export type UpstreamCatalogsState = z.infer<typeof UpstreamCatalogsState>;
export type PermanentUrlsState = z.infer<typeof PermanentUrlsState>;
export type UpdateServiceState = z.infer<typeof UpdateServiceState>;
export type MobileState = z.infer<typeof MobileState>;

export interface Ledger {
  releases: Release[];
  sensors: {
    upstreamCatalogs: UpstreamCatalogsState;
    permanentUrls: PermanentUrlsState;
    updateService: UpdateServiceState | null;
    mobile: MobileState | null;
  };
}
