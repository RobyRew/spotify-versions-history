/** Presentation helpers shared by the pages. */
import type { IconName } from '@robyrew/ui';
import type { Arch, Platform } from '../../../lib/site/model.ts';
import { ARCH_LABELS, PLATFORM_LABELS } from '../../../lib/site/model.ts';

const DATE = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const DATE_TIME = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', hour12: false });

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isFinite(date.getTime()) ? DATE.format(date) : '—';
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? `${DATE_TIME.format(date)} UTC` : '—';
}

/** Decimal megabytes, as download sizes are usually given. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`;
}

export const PLATFORM_ICONS: Readonly<Record<Platform, IconName>> = {
  windows: 'windows', macos: 'apple', linux: 'linux', 'windows-store': 'store', android: 'android', ios: 'apple',
};

export function platformName(platform: Platform, arch?: Arch): string {
  return arch ? `${PLATFORM_LABELS[platform]} ${ARCH_LABELS[arch]}` : PLATFORM_LABELS[platform];
}

/** A short hash for tables: the first and last characters. */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

/** The URL of the versions page with one parameter changed (null removes it); the cursor always resets. */
export function withParam(url: URL, name: string, value: string | null): string {
  const next = new URL(url);
  next.searchParams.delete('cursor');
  if (value === null || value === '') next.searchParams.delete(name);
  else next.searchParams.set(name, value);
  return `${next.pathname}${next.search}`;
}
