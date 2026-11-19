/**
 * amd64fox's LoadSpot table (github.com/LoaderSpot/table): the community mirror at
 * loadspot.amd64fox1.workers.dev. Its entries become each artifact's `listing` and the mirror column.
 * It often lists a build before Spotify's permanent URLs rotate to it (staged rollouts), so it is also an
 * early signal; a file from it is recorded as Spotify's only after the platform signature check.
 */
import { FULL_VERSION, numericVersion } from '../../lib/versions.ts';
import { sourceFor, TARGETS } from '../../lib/v1/sources.ts';
import { sha256Hex } from '../lib/digests.ts';
import { getBytes } from '../lib/http.ts';
import type { Arch, Detection, Format, Platform, Sensor } from '../types.ts';

export const LOADSPOT_TABLE = 'https://raw.githubusercontent.com/LoaderSpot/table/main/table/versions.json';

function isoDate(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return null;
  const result = value.split('.').reverse().join('-');
  const date = new Date(result);
  return Number.isFinite(+date) && date.toISOString().startsWith(result) ? result : null;
}

interface TableAsset { url?: string; date?: string; size?: number }
interface TableEntry { fullversion?: string; buildType?: string; [group: string]: unknown }

/** One detection per build and platform the table lists with a link of the exact LoadSpot shape. */
export function loadspotDetections(table: Record<string, TableEntry>): { detections: Detection[]; notes: string[] } {
  const detections: Detection[] = [];
  const notes: string[] = [];
  for (const [version, entry] of Object.entries(table)) {
    const fullVersion = entry?.fullversion ?? '';
    if (!FULL_VERSION.test(fullVersion) || numericVersion(fullVersion) !== version || (entry.buildType && entry.buildType.toLowerCase() !== 'release')) {
      notes.push(`loadspot: skipped ${version} (${fullVersion || 'no fullversion'}${entry?.buildType ? `, ${entry.buildType}` : ''})`);
      continue;
    }
    for (const [group, key, platform, architecture, , format] of TARGETS) {
      const asset = (entry[group] as Record<string, TableAsset | string> | undefined)?.[key];
      const url = typeof asset === 'string' ? asset : asset?.url;
      const source = sourceFor(url, fullVersion, platform, architecture);
      if (!source || source.kind !== 'mirror') continue;
      const size = typeof asset === 'object' && Number.isSafeInteger(asset.size) && asset.size! > 0 ? asset.size! : null;
      detections.push({
        sensor: 'loadspot', product: 'desktop',
        version, fullVersion,
        platform: platform as Platform, arch: architecture as Arch, format: format as Format,
        url: source.url, lifetime: 'permanent',
        size, claimed: {},
        meta: { date: typeof asset === 'object' ? isoDate(asset.date) : null },
      });
    }
  }
  return { detections, notes };
}

export const loadspot: Sensor = {
  id: 'loadspot',
  describe: "amd64fox's LoadSpot table (community mirror)",
  async detect({ fetch }) {
    const bytes = await getBytes(fetch, LOADSPOT_TABLE);
    if (bytes.length > 8_000_000) throw new Error(`LoadSpot table is ${bytes.length} bytes; refusing an oversized table`);
    const table = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, TableEntry>;
    const { detections, notes } = loadspotDetections(table);
    const newest = detections[0]?.fullVersion ?? null;
    return { state: { tableSha256: sha256Hex(bytes), versions: Object.keys(table).length, newest }, detections, notes };
  },
};
