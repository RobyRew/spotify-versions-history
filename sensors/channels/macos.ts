/**
 * macOS DMGs and the online installer zip at Spotify's permanent URLs on download.scdn.co. They rotate
 * together at release time. The DMG is ~180-200 MB, so its version is taken from the 1.8 MB installer
 * zip's Info.plist; the capture reads Spotify.app's own Info.plist from the DMG and must agree.
 * macOS bundles carry the four-part version only, without the git hash.
 */
import { md5FromEtag } from '../lib/digests.ts';
import { getBytes, head, type HeadInfo } from '../lib/http.ts';
import { parsePlist } from '../lib/plist.ts';
import { readZipEntry, zipEntryNames } from '../lib/zip.ts';
import type { Arch, Detection, Sensor } from '../types.ts';

export const MACOS_INSTALLER = 'https://download.scdn.co/SpotifyInstaller.zip';
export const MACOS_DMGS: readonly { key: string; url: string; arch: Arch }[] = [
  { key: 'x64', url: 'https://download.scdn.co/Spotify.dmg', arch: 'x64' },
  { key: 'arm64', url: 'https://download.scdn.co/SpotifyARM64.dmg', arch: 'arm64' },
];

/** Version and bundle id of the app inside the installer zip. */
export function installerVersion(zip: Uint8Array): { version: string; identifier: string | null } {
  const entry = zipEntryNames(zip).find(name => /^[^/]+\.app\/Contents\/Info\.plist$/.test(name));
  if (!entry) throw new Error('No app Info.plist in the installer zip');
  const plist = parsePlist(readZipEntry(zip, entry));
  const version = plist.CFBundleShortVersionString;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw new Error(`Unexpected installer version ${JSON.stringify(version)}`);
  return { version, identifier: typeof plist.CFBundleIdentifier === 'string' ? plist.CFBundleIdentifier : null };
}

interface InstallerReading extends HeadInfo {
  url: string;
  version: string;
  identifier: string | null;
}

export const macos: Sensor = {
  id: 'macos',
  describe: "Spotify's permanent macOS DMG and installer URLs on download.scdn.co",
  async detect({ fetch, previous, log }) {
    const installerHead = await head(fetch, MACOS_INSTALLER);
    const known = previous?.installer as InstallerReading | undefined;
    let installer: InstallerReading;
    if (known && typeof known.version === 'string' && known.etag && known.etag === installerHead.etag) {
      installer = { ...known, lastModified: installerHead.lastModified, generation: installerHead.generation };
    } else {
      const zip = await getBytes(fetch, MACOS_INSTALLER, { headers: installerHead.etag ? { 'if-match': installerHead.etag } : {}, redirect: 'error' });
      if (installerHead.size && zip.length !== installerHead.size) throw new Error(`${MACOS_INSTALLER}: received ${zip.length} of ${installerHead.size} bytes`);
      installer = { url: MACOS_INSTALLER, ...installerHead, ...installerVersion(zip) };
      log(`macos installer: ETag ${installerHead.etag} is ${installer.version}`);
    }
    const dmgs: Record<string, HeadInfo & { url: string }> = {};
    const detections: Detection[] = [];
    for (const target of MACOS_DMGS) {
      const info = await head(fetch, target.url);
      dmgs[target.key] = { url: target.url, ...info };
      detections.push({
        sensor: 'macos', product: 'desktop',
        version: installer.version, fullVersion: null,
        platform: 'macos', arch: target.arch, format: 'dmg',
        url: target.url, lifetime: 'current-build',
        size: info.size, etag: info.etag, lastModified: info.lastModified,
        claimed: md5FromEtag(info.etag),
        meta: { key: target.key, versionFrom: 'installer-zip' },
      });
    }
    return { state: { installer, dmgs }, detections, notes: [] };
  },
};
