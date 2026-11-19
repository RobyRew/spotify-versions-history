import { describe, expect, it } from 'vitest';
import { parseClearsigned, parseControl, parseRelease } from '../../sensors/lib/deb.ts';
import { md5FromEtag } from '../../sensors/lib/digests.ts';
import { findProductVersion, inspectPortableExecutable, parsePeHeaders, readRemotePe } from '../../sensors/lib/pe.ts';
import { parseBinaryPlist, parsePlist, parseXmlPlist } from '../../sensors/lib/plist.ts';
import { readZipEntry, zipEntryNames } from '../../sensors/lib/zip.ts';
import { fakeFetch, fixture, fixtureText, syntheticPe } from './helpers.ts';

const BUILD = '1.3.10.2586.g81a118a22460';

describe('PE reading', () => {
  const image = syntheticPe(0xaa64, BUILD);

  it('finds the machine, the sections and the certificate table', () => {
    const layout = parsePeHeaders(image.subarray(0, 4096));
    expect(layout.machine).toBe(0xaa64);
    expect(layout.sections.map(section => section.name)).toEqual(['.rsrc']);
    expect(layout.certificate?.size).toBe(Buffer.byteLength('certificate table placeholder'));
    expect(findProductVersion(image)).toBe(BUILD);
    expect(inspectPortableExecutable(image)).toEqual({ machine: 0xaa64, productVersion: BUILD });
  });

  it('reads a remote installer with two range requests pinned to its ETag', async () => {
    const url = 'https://download.scdn.co/SpotifyFullSetupARM64.exe';
    const { fetch, calls } = fakeFetch({ [url]: { bytes: image, etag: '"abc"' } });
    const pe = await readRemotePe(fetch, url, '"abc"', image.length);
    expect(pe).toMatchObject({ arch: 'arm64', productVersion: BUILD });
    expect(calls.map(call => [call.headers.range, call.headers['if-match']])).toEqual([['bytes=0-4095', '"abc"'], ['bytes=4096-4607', '"abc"']]);
  });

  it('fails instead of mixing two builds when the file rotated', async () => {
    const url = 'https://download.scdn.co/SpotifyFullSetupX64.exe';
    const { fetch } = fakeFetch({ [url]: { bytes: image, etag: '"new"' } });
    await expect(readRemotePe(fetch, url, '"old"', image.length)).rejects.toThrow(/412/);
  });

  it('rejects files that are not PE images or carry another version format', () => {
    expect(() => parsePeHeaders(new Uint8Array(4096))).toThrow(/Not a Windows executable/);
    expect(() => inspectPortableExecutable(syntheticPe(0x8664, '2.0.0.1'))).toThrow(/Unexpected ProductVersion/);
  });
});

describe('property lists and zip entries', () => {
  it('reads the binary plist plutil wrote and the XML it came from', async () => {
    const binary = parseBinaryPlist(new Uint8Array(await fixture('macos/Info.sample.binary.plist'))) as Record<string, unknown>;
    expect(binary).toMatchObject({ CFBundleShortVersionString: '1.3.10.2586', CFBundleIdentifier: 'com.example.installer', NSHighResolutionCapable: true });
    expect(binary.Synthetic).toMatch(/héllo$/);
    expect(parseXmlPlist(await fixtureText('macos/Info.sample.xml.plist'))).toMatchObject({ CFBundleVersion: '1.3.10.2586', NSHighResolutionCapable: true });
  });

  it('inflates one entry out of a zip', async () => {
    const zip = new Uint8Array(await fixture('macos/installer-sample.zip'));
    expect(zipEntryNames(zip)).toEqual(['Install Spotify.app/Contents/Info.plist']);
    expect(parsePlist(readZipEntry(zip, 'Install Spotify.app/Contents/Info.plist')).CFBundleShortVersionString).toBe('1.3.10.2586');
    expect(() => readZipEntry(zip, 'missing')).toThrow(/not in the zip/);
  });
});

describe('Debian metadata', () => {
  it('splits a clearsigned InRelease and reads its SHA256 list', async () => {
    const signed = parseClearsigned(await fixtureText('apt/stable-InRelease'));
    expect(signed.hash).toBe('SHA256');
    expect(signed.signature).toMatch(/^-----BEGIN PGP SIGNATURE-----/);
    const release = parseRelease(signed.body);
    expect(release.fields.Suite).toBe('stable');
    expect(release.sha256.get('non-free/binary-amd64/Packages')?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('joins continuation lines into their field', () => {
    expect(parseControl('Package: a\nDescription: one\n two\n\nPackage: b\n')).toEqual([{ Package: 'a', Description: 'one\ntwo' }, { Package: 'b' }]);
  });
});

describe('ETag digests', () => {
  it('treats a 32-hex ETag as the MD5 and anything else as no claim', () => {
    expect(md5FromEtag('"4da214887881217ff9c210c31b528a34"')).toEqual({ md5: '4da214887881217ff9c210c31b528a34' });
    expect(md5FromEtag('"4da2-12"')).toEqual({});
    expect(md5FromEtag(null)).toEqual({});
  });
});
