/** Shared types of the sensors: each one reads a Spotify distribution channel the way its clients do. */
import type { TrustAnchors } from '../lib/trust.ts';
import type { ARCHES, FORMATS, PLATFORMS, PRODUCTS } from '../lib/ledger/schema.ts';

export type Fetch = typeof fetch;
export type Product = (typeof PRODUCTS)[number];
export type Platform = (typeof PLATFORMS)[number];
export type Arch = (typeof ARCHES)[number];
export type Format = (typeof FORMATS)[number];

/**
 * How long the detected URL serves this build:
 *  - current-build: a stable address that serves whatever build is current (download.scdn.co, apt);
 *  - permanent: the address keeps serving this exact build (Snap Store revisions);
 *  - expiring: a signed link, valid until `expiresAt`;
 *  - fetch-on-demand: no URL until the capture asks the channel for one (Microsoft Store FE3).
 */
export type Lifetime = 'current-build' | 'permanent' | 'expiring' | 'fetch-on-demand';

/** Digests the channel itself states for the file, before anything is downloaded. */
export interface ClaimedDigests {
  md5?: string;
  sha1?: string;
  sha256?: string;
  sha512?: string;
  sha3_384?: string;
}

/** One build a channel offers right now. */
export interface Detection {
  sensor: string;
  product: Product;
  /** The numeric version (four parts for desktop builds). */
  version: string;
  /** The full desktop build id with its git hash when the channel names it; null when it does not (macOS, Store). */
  fullVersion: string | null;
  platform: Platform;
  arch: Arch;
  format: Format;
  url: string | null;
  lifetime: Lifetime;
  expiresAt?: string;
  size: number | null;
  etag?: string | null;
  lastModified?: string | null;
  claimed: ClaimedDigests;
  meta: Record<string, string | number | boolean | null | string[]>;
}

export interface SensorContext {
  fetch: Fetch;
  now: Date;
  /** This sensor's last recorded reading (ledger/sensors/<id>.json), or null on a first run. */
  previous: Record<string, unknown> | null;
  trust: TrustAnchors;
  log: (message: string) => void;
}

export interface SensorResult {
  /** The reading to record; written only when it differs from the previous one. */
  state: Record<string, unknown>;
  detections: Detection[];
  notes: string[];
}

export interface Sensor {
  id: string;
  describe: string;
  detect(context: SensorContext): Promise<SensorResult>;
}
