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
 * R2's free tier holds 10 GB a month; past it, storage is billed. The archive stays under this many
 * bytes (ARCHIVE_MAX_BYTES overrides it), so the bucket never leaves the free tier.
 */
export const FREE_TIER_CAP_BYTES = 9_000_000_000;

export const storedBytes = (record: ArchiveRecord): number => Object.values(record.files).reduce((sum, file) => sum + file.size, 0);

/**
 * Splits the wanted builds into those that fit under the cap with what is stored already (newest
 * build first) and those that would pass it. Nothing over the cap is ever uploaded.
 */
export function withinCap(wanted: readonly MergedArtifact[], record: ArchiveRecord, capBytes: number): { fit: MergedArtifact[]; over: MergedArtifact[] } {
  let total = storedBytes(record);
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
