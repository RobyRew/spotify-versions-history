/**
 * Which checked builds to keep a copy of, where the copy goes in R2, and the record of the copies
 * (site/data/archive.json, which the website reads). A build is kept when the merged verification
 * report says it passed at the signed level on every host and the record has no copy with its
 * SHA-256 yet. Objects are content-addressed, `sha256/<hash>/<filename>`, and never overwritten.
 */
import type { MergedArtifact, MergedReport } from '../verify/report.ts';

export interface ArchivedFile {
  key: string;
  product: string;
  version: string;
  fullVersion: string | null;
  platform: string;
  arch: string;
  format: string;
  size: number;
  sha256: string;
  /** The object's path in the bucket and under the files Worker. */
  object: string;
  /** Where the bytes were downloaded from (Store links without their expiring query string). */
  from: string | null;
  level: string;
  archivedAt: string;
}

export interface ArchiveRecord {
  schemaVersion: 1;
  /** The files Worker's origin, e.g. https://spotify-versions-files.<subdomain>.workers.dev. */
  base: string | null;
  files: Record<string, ArchivedFile>;
}

export const emptyRecord = (base: string | null = null): ArchiveRecord => ({ schemaVersion: 1, base, files: {} });

/** The download name of a copy: `spotify-<build>-<platform>-<arch>.<format>`, safe in a URL path. */
export function archiveFilename(artifact: Pick<MergedArtifact, 'version' | 'fullVersion' | 'platform' | 'arch' | 'format'>): string {
  return `spotify-${artifact.fullVersion ?? artifact.version}-${artifact.platform}-${artifact.arch}.${artifact.format}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

export const objectKey = (sha256: string, filename: string): string => `sha256/${sha256}/${filename}`;

/** The checked builds with no copy yet (or whose record names another SHA-256). */
export function filesToArchive(report: MergedReport, record: ArchiveRecord): MergedArtifact[] {
  return report.artifacts.filter(artifact =>
    artifact.ok
    && artifact.level === 'signed'
    && typeof artifact.sha256 === 'string' && /^[0-9a-f]{64}$/.test(artifact.sha256)
    && typeof artifact.size === 'number' && artifact.size > 0
    && record.files[artifact.key]?.sha256 !== artifact.sha256);
}

/**
 * R2's free tier holds 10 GB-month of Standard storage (the average of each day's peak); past it,
 * storage is billed. The archive plans and writes copies only while the bucket stays at or under
 * this many bytes, 9 × 10⁹, which is below 10 GB whether a GB is 10⁹ or 2³⁰ bytes.
 */
export const FREE_TIER_CAP_BYTES = 9_000_000_000;

/**
 * The cap for a run: FREE_TIER_CAP_BYTES, or ARCHIVE_MAX_BYTES when that is lower. The variable can
 * lower the cap (0 stores nothing) but not raise it; a value that is not a whole number of bytes
 * throws, so the run stores nothing rather than guess.
 */
export function capFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return FREE_TIER_CAP_BYTES;
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error(`ARCHIVE_MAX_BYTES must be a whole number of bytes, not ${JSON.stringify(value)}`);
  return Math.min(bytes, FREE_TIER_CAP_BYTES);
}

export const storedBytes = (record: ArchiveRecord): number => Object.values(record.files).reduce((sum, file) => sum + file.size, 0);

/**
 * What the bucket is counted as holding: the larger of its listed total and the record's, so an
 * object the record lacks (a run that stored it but did not commit) and a record entry the
 * listing lacks both keep counting.
 */
export const countedBytes = (listed: number, record: ArchiveRecord): number => Math.max(listed, storedBytes(record));

/**
 * Splits the wanted builds into those that fit under the cap on top of `stored` bytes (newest build
 * first) and those that would pass it. `stored` is what the bucket is counted as holding: the
 * larger of the bucket's listed total and the record's (sensors/archive.ts).
 */
export function withinCap(wanted: readonly MergedArtifact[], stored: number, capBytes: number): { fit: MergedArtifact[]; over: MergedArtifact[] } {
  let total = stored;
  const fit: MergedArtifact[] = [];
  const over: MergedArtifact[] = [];
  const newestFirst = [...wanted].sort((a, b) => {
    const left = a.version.split('.').map(Number);
    const right = b.version.split('.').map(Number);
    for (let index = 0; index < 4; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (right[index] ?? 0) - (left[index] ?? 0);
    return a.key.localeCompare(b.key);
  });
  for (const artifact of newestFirst) {
    if (total + artifact.size! <= capBytes) {
      fit.push(artifact);
      total += artifact.size!;
    } else {
      over.push(artifact);
    }
  }
  return { fit, over };
}

export function recordEntry(artifact: MergedArtifact, from: string | null, now: Date): ArchivedFile {
  const filename = archiveFilename(artifact);
  return {
    key: artifact.key,
    product: 'desktop',
    version: artifact.version,
    fullVersion: artifact.fullVersion,
    platform: artifact.platform,
    arch: artifact.arch,
    format: artifact.format,
    size: artifact.size!,
    sha256: artifact.sha256!,
    object: objectKey(artifact.sha256!, filename),
    from,
    level: artifact.level,
    archivedAt: now.toISOString(),
  };
}

/** The public URL of a copy, from the record's base (or an override) and the object path. */
export function copyUrl(base: string, file: Pick<ArchivedFile, 'object'>): string {
  return `${base.replace(/\/+$/, '')}/${file.object}`;
}
