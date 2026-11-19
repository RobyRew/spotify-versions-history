/**
 * Windows installers at Spotify's permanent URLs on download.scdn.co. Each URL serves whatever build is
 * current; a changed ETag means a new build, identified from the PE resources with range requests.
 */
import { numericVersion } from '../../lib/versions.ts';
import { md5FromEtag } from '../lib/digests.ts';
import { head } from '../lib/http.ts';
import { readRemotePe } from '../lib/pe.ts';
import type { Arch, Detection, Sensor } from '../types.ts';

interface WindowsUrl {
  key: string;
  url: string;
  arch: Arch;
  /** false for the online installer: it downloads the full build at install time, so only its version is recorded. */
  archived: boolean;
}

export const WINDOWS_URLS: readonly WindowsUrl[] = [
  { key: 'x64', url: 'https://download.scdn.co/SpotifyFullSetupX64.exe', arch: 'x64', archived: true },
  { key: 'arm64', url: 'https://download.scdn.co/SpotifyFullSetupARM64.exe', arch: 'arm64', archived: true },
  { key: 'x86', url: 'https://download.scdn.co/SpotifyFullSetup.exe', arch: 'x86', archived: true },
  { key: 'online', url: 'https://download.scdn.co/SpotifySetup.exe', arch: 'x64', archived: false },
];

export interface WindowsReading {
  url: string;
  etag: string | null;
  size: number | null;
  lastModified: string | null;
  generation: string | null;
  productVersion: string;
  arch: Arch;
}

function knownReading(value: unknown): WindowsReading | null {
  const reading = value as Partial<WindowsReading> | null | undefined;
  return reading && typeof reading.productVersion === 'string' && typeof reading.etag === 'string' ? reading as WindowsReading : null;
}

export const windows: Sensor = {
  id: 'windows',
  describe: "Spotify's permanent Windows installer URLs on download.scdn.co",
  async detect({ fetch, previous, log }) {
    const before = (previous?.urls ?? {}) as Record<string, unknown>;
    const urls: Record<string, WindowsReading> = {};
    const detections: Detection[] = [];
    for (const target of WINDOWS_URLS) {
      const info = await head(fetch, target.url);
      const known = knownReading(before[target.key]);
      let reading: WindowsReading;
      if (known && info.etag && known.etag === info.etag && known.size === info.size) {
        reading = { ...known, lastModified: info.lastModified, generation: info.generation };
      } else {
        const pe = await readRemotePe(fetch, target.url, info.etag, info.size);
        if (pe.arch !== target.arch) throw new Error(`${target.url}: machine 0x${pe.machine.toString(16)} is not ${target.arch}`);
        reading = { url: target.url, ...info, productVersion: pe.productVersion, arch: pe.arch };
        log(`windows ${target.key}: ETag ${info.etag} serves ${pe.productVersion} (${pe.bytesRead} bytes read)`);
      }
      urls[target.key] = reading;
      if (!target.archived) continue;
      detections.push({
        sensor: 'windows', product: 'desktop',
        version: numericVersion(reading.productVersion), fullVersion: reading.productVersion,
        platform: 'windows', arch: target.arch, format: 'exe',
        url: target.url, lifetime: 'current-build',
        size: reading.size, etag: reading.etag, lastModified: reading.lastModified,
        claimed: md5FromEtag(reading.etag),
        meta: { key: target.key },
      });
    }
    return { state: { urls }, detections, notes: [] };
  },
};
