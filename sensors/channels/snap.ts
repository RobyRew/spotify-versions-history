/**
 * The Snap Store's `spotify` snap. Every revision keeps a permanent download URL, so it is the one
 * channel with an official per-version link that does not expire. A file is accepted when its
 * sha3-384 and size equal the Canonical-signed snap-revision assertion, looked up by that digest.
 */
import type { TrustAnchors } from '../../lib/trust.ts';
import { FULL_VERSION, numericVersion } from '../../lib/versions.ts';
import { getJson } from '../lib/http.ts';
import type { Arch, Detection, Sensor } from '../types.ts';

export const SNAP_INFO = 'https://api.snapcraft.io/v2/snaps/info/spotify?fields=channel-map,revision,version,download,created-at,base,confinement';
const ARCHES: Readonly<Record<string, Arch>> = { amd64: 'x64', arm64: 'arm64', i386: 'x86' };

interface ChannelMapEntry {
  channel: { name: string; architecture: string; track?: string; risk?: string };
  revision: number;
  version: string;
  'created-at'?: string;
  base?: string;
  confinement?: string;
  download: { url: string; size: number; 'sha3-384': string };
}

/** The key assertions.ubuntu.com files a snap-revision assertion under: its sha3-384, base64url, no padding. */
export function snapAssertionKey(sha3_384: string): string {
  return Buffer.from(sha3_384, 'hex').toString('base64url');
}

/** Header fields of an assertion (the part before the first blank line). */
export function parseAssertionHeaders(text: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (line === '') break;
    const colon = line.indexOf(': ');
    if (colon > 0 && !line.startsWith(' ')) headers[line.slice(0, colon)] = line.slice(colon + 2);
  }
  return headers;
}

export function snapDetections(info: unknown, trust: TrustAnchors): { reading: Record<string, unknown>; detections: Detection[]; notes: string[] } {
  const data = info as { 'snap-id'?: string; name?: string; 'channel-map'?: ChannelMapEntry[] };
  if (data['snap-id'] !== trust.snap.snapId) throw new Error(`snap-id ${data['snap-id']} is not the pinned ${trust.snap.snapId}`);
  const byRevision = new Map<string, { entry: ChannelMapEntry; channels: string[] }>();
  const notes: string[] = [];
  for (const entry of data['channel-map'] ?? []) {
    const key = `${entry.revision}/${entry.channel.architecture}`;
    const existing = byRevision.get(key);
    if (existing) existing.channels.push(entry.channel.name);
    else byRevision.set(key, { entry, channels: [entry.channel.name] });
  }
  const detections: Detection[] = [];
  for (const { entry, channels } of byRevision.values()) {
    const arch = ARCHES[entry.channel.architecture];
    if (!arch || !FULL_VERSION.test(entry.version)) {
      notes.push(`snap revision ${entry.revision} (${entry.channel.architecture}, ${entry.version}) skipped`);
      continue;
    }
    detections.push({
      sensor: 'snap', product: 'desktop',
      version: numericVersion(entry.version), fullVersion: entry.version,
      platform: 'linux', arch, format: 'snap',
      url: entry.download.url, lifetime: 'permanent',
      size: entry.download.size,
      claimed: { sha3_384: entry.download['sha3-384'] },
      meta: { revision: entry.revision, channels, createdAt: entry['created-at'] ?? null, base: entry.base ?? null, confinement: entry.confinement ?? null },
    });
  }
  const channelMap = (data['channel-map'] ?? []).map(entry => ({ channel: entry.channel.name, architecture: entry.channel.architecture, revision: entry.revision, version: entry.version }));
  return { reading: { snapId: data['snap-id'], channelMap }, detections, notes };
}

export const snap: Sensor = {
  id: 'snap',
  describe: "The Snap Store's spotify snap (every revision keeps its download URL)",
  async detect({ fetch, trust }) {
    const info = await getJson(fetch, SNAP_INFO, { headers: { 'Snap-Device-Series': '16' } });
    const { reading, detections, notes } = snapDetections(info, trust);
    return { state: reading, detections, notes };
  },
};
