/**
 * The App Store listing of Spotify for iPhone and iPad (one universal app), read through the public
 * iTunes lookup per storefront. iOS is recorded as metadata only: an App Store IPA is encrypted for,
 * and only installs on, the account that downloaded it (docs/IOS.md).
 */
import type { TrustAnchors } from '../../lib/trust.ts';
import { getJson } from '../lib/http.ts';
import type { Sensor } from '../types.ts';

/** Four storefronts; the lookup allows about 20 calls a minute. */
export const IOS_STOREFRONTS = ['us', 'gb', 'es', 'jp'] as const;

export interface IosReading {
  version: string;
  releasedAt: string | null;
  minimumOsVersion: string | null;
  fileSizeBytes: number | null;
  devices: number;
  listing: string;
}

export function itunesReading(payload: unknown, trust: TrustAnchors): IosReading | null {
  const results = (payload as { results?: Record<string, unknown>[] }).results ?? [];
  const app = results.find(row => row.trackId === trust.ios.trackId && row.bundleId === trust.ios.bundleId);
  if (!app || typeof app.version !== 'string' || !/^\d+(\.\d+){1,3}$/.test(app.version)) return null;
  const size = Number(app.fileSizeBytes);
  return {
    version: app.version,
    releasedAt: typeof app.currentVersionReleaseDate === 'string' ? app.currentVersionReleaseDate : null,
    minimumOsVersion: typeof app.minimumOsVersion === 'string' ? app.minimumOsVersion : null,
    fileSizeBytes: Number.isSafeInteger(size) && size > 0 ? size : null,
    devices: Array.isArray(app.supportedDevices) ? app.supportedDevices.length : 0,
    listing: `https://apps.apple.com/app/id${trust.ios.trackId}`,
  };
}

export const ios: Sensor = {
  id: 'ios',
  describe: 'The App Store listing (iTunes lookup), metadata only',
  async detect({ fetch, trust }) {
    const storefronts: Record<string, IosReading | null> = {};
    const notes: string[] = [];
    for (const country of IOS_STOREFRONTS) {
      storefronts[country] = itunesReading(await getJson(fetch, `https://itunes.apple.com/lookup?id=${trust.ios.trackId}&country=${country}`), trust);
      if (!storefronts[country]) notes.push(`ios ${country}: no listing for ${trust.ios.bundleId}`);
    }
    return { state: { storefronts }, detections: [], notes };
  },
};
