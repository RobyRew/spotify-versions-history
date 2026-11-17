import { describe, expect, it } from 'vitest';
import { compareVersions, desktopToStore, isFullVersion, numericVersion, storeToDesktop, unpackPackageVersion } from '../lib/versions.ts';

describe('desktop build versions', () => {
  it('accepts the 8-digit and the 12-digit git hash forms', () => {
    expect(isFullVersion('1.2.93.667.g7b5cc0ce')).toBe(true);
    expect(isFullVersion('1.3.10.2586.g81a118a22460')).toBe(true);
    expect(isFullVersion('1.3.10.2586')).toBe(false);
    expect(isFullVersion('1:1.0.72.117.g6bd7cc73-35')).toBe(false);
  });

  it('orders by the four numeric parts and ignores the hash', () => {
    expect(compareVersions('1.3.10.2586.g81a118a22460', '1.3.9.2055.g806b5b278de8')).toBeGreaterThan(0);
    expect(compareVersions('1.2.7.1277', '1.2.53.440')).toBeLessThan(0);
    expect(compareVersions('1.3.1.234.g59d6bf59', '1.3.1.234.gffffffff')).toBe(0);
    expect(numericVersion('1.3.10.2586.g81a118a22460')).toBe('1.3.10.2586');
  });
});

describe('Microsoft Store package versions', () => {
  it('maps the pairs read from displaycatalog to desktop builds', () => {
    expect(storeToDesktop('1.309.2055.0')).toBe('1.3.9.2055');
    expect(storeToDesktop('1.253.440.0')).toBe('1.2.53.440');
    expect(desktopToStore('1.3.9.2055.g806b5b278de8')).toBe('1.309.2055.0');
    expect(desktopToStore('1.3.10.2586')).toBe('1.310.2586.0');
  });

  it('unpacks the UInt64 package version displaycatalog sends', () => {
    expect(unpackPackageVersion('282802256281600')).toBe('1.309.2055.0');
    expect(unpackPackageVersion(282802256281600n)).toBe('1.309.2055.0');
  });

  it('refuses shapes it cannot map', () => {
    expect(storeToDesktop('1.309.2055.1')).toBeNull();
    expect(desktopToStore('1.3.100.1')).toBeNull();
  });
});
