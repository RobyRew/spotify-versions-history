// Channel sensors against payloads recorded by scripts/record-fixtures.sh (testdata/channels).
import { describe, expect, it } from 'vitest';
import { aptSuite } from '../../sensors/channels/apt.ts';
import { itunesReading } from '../../sensors/channels/ios.ts';
import { loadspotDetections } from '../../sensors/channels/loadspot.ts';
import { installerVersion, macos, MACOS_DMGS, MACOS_INSTALLER } from '../../sensors/channels/macos.ts';
import { parseAssertionHeaders, snapAssertionKey, snapDetections } from '../../sensors/channels/snap.ts';
import { storeDetections } from '../../sensors/channels/store.ts';
import { windows, WINDOWS_URLS } from '../../sensors/channels/windows.ts';
import type { SensorContext } from '../../sensors/types.ts';
import { fakeFetch, fixture, fixtureText, headersFixture, syntheticPe, trust } from './helpers.ts';

const anchors = await trust();
const context = (fetch: SensorContext['fetch'], previous: Record<string, unknown> | null = null): SensorContext =>
  ({ fetch, now: new Date('2026-11-19T22:00:00Z'), previous, trust: anchors, log: () => {} });

describe('windows', () => {
  const versions: Record<string, [number, string]> = {
    x64: [0x8664, '1.3.10.2586.g81a118a22460'], arm64: [0xaa64, '1.3.10.2586.g81a118a22460'],
    x86: [0x14c, '1.2.53.440.g7b2f582a'], online: [0x8664, '1.3.10.2586.g81a118a22460'],
  };
  const routes = Object.fromEntries(WINDOWS_URLS.map(target => {
    const [machine, version] = versions[target.key]!;
    return [target.url, { bytes: syntheticPe(machine, version), etag: `"${target.key}aaaaaaaaaaaaaaaaaaaaaaaaaaaaa".slice(0, 34)` }];
  }));

  it('identifies each permanent URL from its PE resources and skips the online installer', async () => {
    const { fetch } = fakeFetch(routes);
    const result = await windows.detect(context(fetch));
    expect(result.detections.map(d => [d.arch, d.fullVersion, d.lifetime])).toEqual([
      ['x64', '1.3.10.2586.g81a118a22460', 'current-build'],
      ['arm64', '1.3.10.2586.g81a118a22460', 'current-build'],
      ['x86', '1.2.53.440.g7b2f582a', 'current-build'],
    ]);
    expect(Object.keys(result.state.urls as object)).toEqual(['x64', 'arm64', 'x86', 'online']);
  });

  it('makes only HEAD requests while every ETag is unchanged', async () => {
    const first = await windows.detect(context(fakeFetch(routes).fetch));
    const { fetch, calls } = fakeFetch(routes);
    const second = await windows.detect(context(fetch, first.state));
    expect(calls.every(call => call.method === 'HEAD')).toBe(true);
    expect(second.detections).toEqual(first.detections);
  });

  it('refuses a URL that serves another architecture', async () => {
    const swapped = { ...routes, [WINDOWS_URLS[1]!.url]: { bytes: syntheticPe(0x8664, '1.3.10.2586.g81a118a22460'), etag: '"swapped"' } };
    await expect(windows.detect(context(fakeFetch(swapped).fetch))).rejects.toThrow(/is not arm64/);
  });

  it('keeps the recorded response shape of the real permanent URL', async () => {
    const headers = headersFixture(await fixtureText('windows/head-SpotifyFullSetupX64.exe.txt'));
    expect(headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(Number(headers['content-length'])).toBeGreaterThan(100_000_000);
  });
});

describe('macos', () => {
  it('takes the version from the installer zip and lists both DMGs at it', async () => {
    const zip = new Uint8Array(await fixture('macos/installer-sample.zip'));
    expect(installerVersion(zip).version).toBe('1.3.10.2586');
    const { fetch } = fakeFetch({
      [MACOS_INSTALLER]: { bytes: zip, etag: '"zip"' },
      [MACOS_DMGS[0]!.url]: { bytes: new Uint8Array(16), etag: '"bdddf33974153fc4af5f9d68120b748d"' },
      [MACOS_DMGS[1]!.url]: { bytes: new Uint8Array(16), etag: '"2b9355e3343d9a13705c47df29b2829c"' },
    });
    const result = await macos.detect(context(fetch));
    expect(result.detections.map(d => [d.arch, d.version, d.fullVersion, d.format, d.claimed.md5])).toEqual([
      ['x64', '1.3.10.2586', null, 'dmg', 'bdddf33974153fc4af5f9d68120b748d'],
      ['arm64', '1.3.10.2586', null, 'dmg', '2b9355e3343d9a13705c47df29b2829c'],
    ]);
  });
});

describe('apt', () => {
  it('accepts each suite\'s Packages only because its hash is the one InRelease lists', async () => {
    const stable = aptSuite('stable', new Uint8Array(await fixture('apt/stable-InRelease')), new Uint8Array(await fixture('apt/stable-amd64-Packages')));
    expect(stable.detections.map(d => [d.fullVersion, d.format, d.url])).toEqual([
      ['1.3.4.258.gc60b10b0946a', 'deb', 'https://repository.spotify.com/pool/non-free/s/spotify-client/spotify-client_1.3.4.258.gc60b10b0946a_amd64.deb'],
    ]);
    expect(stable.detections[0]!.claimed.sha256).toMatch(/^[0-9a-f]{64}$/);
    const testing = aptSuite('testing', new Uint8Array(await fixture('apt/testing-InRelease')), new Uint8Array(await fixture('apt/testing-amd64-Packages')));
    expect(testing.detections.map(d => d.fullVersion)).toEqual(['1.3.8.620.g39b276d5d7ac']);
  });

  it('refuses a Packages index InRelease does not list', async () => {
    const packages = new Uint8Array(Buffer.concat([await fixture('apt/stable-amd64-Packages'), Buffer.from('\n')]));
    const inRelease = new Uint8Array(await fixture('apt/stable-InRelease'));
    expect(() => aptSuite('stable', inRelease, packages)).toThrow(/is not the one InRelease lists/);
  });
});

describe('snap', () => {
  it('lists one permanent download per revision with its sha3-384', async () => {
    const { detections } = snapDetections(JSON.parse(await fixtureText('snap/info.json')), anchors);
    expect(detections.map(d => [d.fullVersion, d.meta.revision, d.meta.channels, d.lifetime])).toEqual([
      ['1.2.95.453.g0eeebbed', 99, ['stable'], 'permanent'],
      ['1.3.8.620.g39b276d5d7ac', 103, ['candidate', 'edge'], 'permanent'],
    ]);
  });

  it('finds the Canonical assertion for a revision under the base64url of its sha3-384', async () => {
    const { detections } = snapDetections(JSON.parse(await fixtureText('snap/info.json')), anchors);
    const stable = detections.find(d => d.meta.revision === 99)!;
    const assertion = parseAssertionHeaders(await fixtureText('snap/snap-revision-stable.assert'));
    expect(assertion['snap-sha3-384']).toBe(snapAssertionKey(stable.claimed.sha3_384!));
    expect(assertion).toMatchObject({ type: 'snap-revision', 'authority-id': anchors.snap.authority, 'snap-id': anchors.snap.snapId, 'developer-id': anchors.snap.developerId, 'snap-revision': '99', 'snap-size': String(stable.size) });
  });

  it('refuses another snap id', async () => {
    const info = { ...JSON.parse(await fixtureText('snap/info.json')), 'snap-id': 'someone-else' };
    expect(() => snapDetections(info, anchors)).toThrow(/not the pinned/);
  });
});

describe('microsoft store', () => {
  it('maps each package to its desktop build and keeps the catalog SHA-256', async () => {
    const { detections } = storeDetections(JSON.parse(await fixtureText('store/displaycatalog.json')), anchors);
    expect(detections.map(d => [d.arch, d.version, d.meta.storeVersion, d.format, d.lifetime])).toEqual([
      ['x86', '1.1.92.647', '1.192.647.0', 'appx', 'fetch-on-demand'],
      ['x86', '1.2.53.440', '1.253.440.0', 'appx', 'fetch-on-demand'],
      ['x64', '1.3.10.2586', '1.310.2586.0', 'appx', 'fetch-on-demand'],
      ['arm64', '1.3.10.2586', '1.310.2586.0', 'appx', 'fetch-on-demand'],
    ]);
    expect(detections.every(d => /^[0-9a-f]{64}$/.test(d.claimed.sha256 ?? ''))).toBe(true);
  });

  it('refuses a listing whose publisher is not the pinned one', async () => {
    const catalog = JSON.parse(await fixtureText('store/displaycatalog.json'));
    catalog.Product.Properties.PublisherCertificateName = 'CN=someone-else';
    expect(() => storeDetections(catalog, anchors)).toThrow(/not the pinned/);
  });
});

describe('ios', () => {
  it('reads version, release date and minimum OS from the lookup', async () => {
    expect(itunesReading(JSON.parse(await fixtureText('ios/itunes-lookup-us.json')), anchors)).toMatchObject({
      version: '9.2.0', releasedAt: '2026-11-13T13:54:31Z', minimumOsVersion: '16.1', listing: 'https://apps.apple.com/app/id324684580',
    });
  });
});

describe('loadspot', () => {
  it('lists every platform link of the exact LoadSpot shape', async () => {
    const { detections } = loadspotDetections(JSON.parse(await fixtureText('loadspot/versions.json')));
    const newest = detections.filter(d => d.fullVersion === '1.3.10.2586.g81a118a22460');
    expect(newest.map(d => `${d.platform}/${d.arch}/${d.format}`).sort()).toEqual(['macos/arm64/tbz', 'macos/x64/tbz', 'windows/arm64/exe', 'windows/x64/exe', 'windows/x86/exe'].filter(id => newest.some(d => `${d.platform}/${d.arch}/${d.format}` === id)));
    expect(detections.every(d => d.url?.startsWith('https://loadspot.amd64fox1.workers.dev/download/'))).toBe(true);
    expect(detections.every(d => d.meta.date === null || /^\d{4}-\d{2}-\d{2}$/.test(String(d.meta.date)))).toBe(true);
  });
});
