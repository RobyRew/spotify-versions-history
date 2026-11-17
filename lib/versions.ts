/** A Spotify desktop build: 1.<minor>.<patch>.<build>.g<git hash>. The hash grew from 8 to 12 hex digits in 2026. */
export const FULL_VERSION = /^1\.\d{1,5}\.\d{1,5}\.\d{1,8}\.g[0-9a-f]{8,40}$/i;

export function isFullVersion(value: unknown): value is string {
  return typeof value === 'string' && FULL_VERSION.test(value);
}

/** The four numeric parts of a build: 1.3.10.2586 for 1.3.10.2586.g81a118a22460. */
export function numericVersion(fullVersion: string): string {
  return fullVersion.split('.').slice(0, 4).join('.');
}

/** Orders by the first four numeric parts; the git hash after them is ignored. */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').slice(0, 4).map(Number);
  const right = b.split('.').slice(0, 4).map(Number);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
  return 0;
}

/**
 * Microsoft Store packages carry the desktop build as 1.<minor·100+patch>.<build>.0. Pairs read from
 * displaycatalog on 2026-11-17: 1.309.2055.0 is desktop 1.3.9.2055, legacy x86 1.253.440.0 is 1.2.53.440.
 */
export function storeToDesktop(storeVersion: string): string | null {
  const match = /^1\.(\d{1,5})\.(\d{1,8})\.0$/.exec(storeVersion);
  if (!match) return null;
  const packed = Number(match[1]);
  return `1.${Math.floor(packed / 100)}.${packed % 100}.${match[2]}`;
}

/** The inverse of storeToDesktop; null when the patch number does not fit two digits. */
export function desktopToStore(version: string): string | null {
  const match = /^1\.(\d{1,3})\.(\d{1,2})\.(\d{1,8})(?:\.|$)/.exec(version);
  if (!match) return null;
  return `1.${Number(match[1]) * 100 + Number(match[2])}.${match[3]}.0`;
}

/** displaycatalog's packed UInt64 package version: four 16-bit fields, major first. */
export function unpackPackageVersion(packed: string | number | bigint): string {
  const value = BigInt(packed);
  const part = (shift: bigint) => Number((value >> shift) & 0xffffn);
  return `${part(48n)}.${part(32n)}.${part(16n)}.${part(0n)}`;
}
