import { describe, expect, it } from 'vitest';
import { isExpired, orderedSources } from '../lib/v1/catalog.ts';
import { sourceFor } from '../lib/v1/sources.ts';

const BUILD = '1.3.1.234.g59d6bf59';
const UPGRADE = `https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-${BUILD}-5377.exe`;

describe('v1 source allowlist', () => {
  it('keeps a signed upgrade link live and its bare path as an expired record', () => {
    const signed = sourceFor(`${UPGRADE}?fauth=eyJhbGciOiJ.eyJpc3Mi.c2ln-_~`, BUILD, 'windows', 'x64');
    expect(signed).toEqual({ url: `${UPGRADE}?fauth=eyJhbGciOiJ.eyJpc3Mi.c2ln-_~`, kind: 'official', label: 'Spotify CDN' });
    expect(isExpired(signed!)).toBe(false);
    const bare = sourceFor(UPGRADE, BUILD, 'windows', 'x64');
    expect(bare?.label).toBe('Spotify CDN');
    expect(isExpired(bare!)).toBe(true);
  });

  it('rejects other schemes, credentials, ports, fragments and queries', () => {
    expect(sourceFor(UPGRADE.replace('https:', 'http:'), BUILD, 'windows', 'x64')).toBeNull();
    expect(sourceFor(UPGRADE.replace('https://', 'https://user:pw@'), BUILD, 'windows', 'x64')).toBeNull();
    expect(sourceFor(UPGRADE.replace('scdn.co', 'scdn.co:8443'), BUILD, 'windows', 'x64')).toBeNull();
    expect(sourceFor(`${UPGRADE}#x`, BUILD, 'windows', 'x64')).toBeNull();
    expect(sourceFor(`${UPGRADE}?token=1`, BUILD, 'windows', 'x64')).toBeNull();
    expect(sourceFor(`https://download.scdn.co/SpotifyFullSetupX64.exe?fauth=a`, BUILD, 'windows', 'x64')).toBeNull();
  });

  it('accepts a path only for the build, platform and architecture it names', () => {
    expect(sourceFor(UPGRADE, BUILD, 'windows', 'arm64')).toBeNull();
    expect(sourceFor(UPGRADE, '1.3.1.235.g59d6bf59', 'windows', 'x64')).toBeNull();
    expect(sourceFor('https://download.scdn.co/SpotifyFullSetupX64.exe', BUILD, 'windows', 'x64')?.label).toBe('Spotify (current build)');
    expect(sourceFor('https://download.scdn.co/SpotifyFullSetupX64.exe', BUILD, 'windows', 'arm64')).toBeNull();
    expect(sourceFor(`https://loadspot.amd64fox1.workers.dev/download/spotify_installer-${BUILD}-x64.exe`, BUILD, 'windows', 'x64')?.kind).toBe('mirror');
    expect(sourceFor(`https://loadspot.amd64fox1.workers.dev/download/spotify_installer-${BUILD}-arm64.exe`, BUILD, 'windows', 'x64')).toBeNull();
    const deb = '1.2.95.453.g2e4c4aa0';
    expect(sourceFor(`https://repository.spotify.com/pool/non-free/s/spotify-client/spotify-client_${deb}_amd64.deb`, deb, 'linux', 'x64')?.label).toBe('Spotify repository');
    expect(sourceFor(`https://repository.spotify.com/pool/non-free/s/spotify-client/spotify-client_${deb}_amd64.deb`, deb, 'linux', 'arm64')).toBeNull();
  });

  it('puts live sources before expired ones, Spotify first', () => {
    const sources = [
      { url: 'https://loadspot.amd64fox1.workers.dev/download/x.exe', kind: 'mirror' as const, label: 'LoadSpot mirror' },
      { url: UPGRADE, kind: 'official' as const, label: 'Spotify CDN' },
      { url: 'https://download.scdn.co/SpotifyFullSetupX64.exe', kind: 'official' as const, label: 'Spotify (current build)' },
    ];
    expect(orderedSources({ sources }).map(source => source.label)).toEqual(['Spotify (current build)', 'LoadSpot mirror', 'Spotify CDN']);
  });
});
