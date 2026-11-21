import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TrustAnchors } from '../../lib/trust.ts';
import {
  FE3_SECURED_URL, FE3_URL, Fe3Error, getCookieRequest, listStorePackages, parseCookie, parseSyncUpdates, resolveDownload,
  type Fe3Transport, type StorePackageFile,
} from '../../sensors/store/fe3.ts';
import { here, trust as loadTrust } from '../sensors/helpers.ts';

const NOW = new Date('2026-11-20T12:56:27.000Z');
const fixture = (name: string) => readFile(here(`../../testdata/store/fe3/${name}`), 'utf8');

/** Answers GetCookie, then the recorded SyncUpdates rounds in order, then GetExtendedUpdateInfo2. */
async function recordedTransport(overrides: { fileUrl?: string; sync?: string[] } = {}): Promise<{ transport: Fe3Transport; requests: { url: string; body: string }[] }> {
  const cookie = await fixture('getcookie.response.xml');
  const rounds = overrides.sync ?? await Promise.all([1, 2, 3, 4].map(round => fixture(`sync-round${round}.response.xml`)));
  const fileUrl = overrides.fileUrl ?? await fixture('extended-update-info2.response.xml');
  const requests: { url: string; body: string }[] = [];
  let round = 0;
  const transport: Fe3Transport = {
    post: async (url, body) => {
      requests.push({ url, body });
      if (body.includes('<GetCookie ')) return { status: 200, body: cookie };
      if (body.includes('<SyncUpdates ')) return { status: 200, body: rounds[Math.min(round++, rounds.length - 1)]! };
      if (body.includes('<GetExtendedUpdateInfo2 ')) return { status: 200, body: fileUrl };
      return { status: 400, body: '' };
    },
  };
  return { transport, requests };
}

describe('FE3', () => {
  let anchors: TrustAnchors;
  beforeAll(async () => { anchors = await loadTrust(); });

  it('stamps every request with an Expires after its Created', () => {
    const request = getCookieRequest(NOW);
    const created = /<Created>([^<]+)<\/Created>/.exec(request)![1]!;
    const expires = /<Expires>([^<]+)<\/Expires>/.exec(request)![1]!;
    expect(Date.parse(expires) - Date.parse(created)).toBe(5 * 60_000);
  });

  it('reports non-leaf updates as installed until the packages come back, and keeps only Spotify\'s', async () => {
    const { transport, requests } = await recordedTransport();
    const listing = await listStorePackages(transport, anchors, NOW);
    expect(listing.rounds).toBe(4);
    expect(listing.packages.map(pkg => pkg.packageFullName)).toEqual([
      'SpotifyAB.SpotifyMusic_1.192.647.0_x86__zpdnekdrzrea0',
      'SpotifyAB.SpotifyMusic_1.253.440.0_x86__zpdnekdrzrea0',
      'SpotifyAB.SpotifyMusic_1.310.2586.0_arm64__zpdnekdrzrea0',
      'SpotifyAB.SpotifyMusic_1.310.2586.0_x64__zpdnekdrzrea0',
    ]);
    expect(listing.others).toEqual(expect.arrayContaining([expect.stringMatching(/^Microsoft\.VCLibs/), expect.stringMatching(/^Microsoft\.WindowsAppRuntime/)]));
    const x64 = listing.packages.at(-1)!;
    expect(x64).toMatchObject({ size: 227483806, mainPackage: true, sha256: '0668cf2b4a85ddd4249da5f908c671c06ef9eb8874e0065b56a20d9e43f32a5c' });
    // Round 2 reports round 1's non-leaf ids as installed.
    const sync = requests.filter(request => request.body.includes('<SyncUpdates '));
    const round1Ids = parseSyncUpdates(await fixture('sync-round1.response.xml')).updates.map(update => update.numericId);
    expect(sync[0]!.body).toContain('<InstalledNonLeafUpdateIDs></InstalledNonLeafUpdateIDs>');
    for (const id of round1Ids) expect(sync[1]!.body).toContain(`<int>${id}</int>`);
    expect(requests.every(request => request.url === FE3_URL)).toBe(true);
  });

  it('picks the download location whose SHA-1 is the package file\'s', async () => {
    const { transport, requests } = await recordedTransport();
    const listing = await listStorePackages(transport, anchors, NOW);
    const x64 = listing.packages.find(pkg => pkg.packageFullName.includes('_x64_'))!;
    const download = await resolveDownload(transport, x64, NOW);
    expect(new URL(download.url).hostname).toBe('tlu.dl.delivery.mp.microsoft.com');
    expect(download.sha1).toBe(x64.sha1);
    expect(requests.at(-1)!.url).toBe(FE3_SECURED_URL);
    expect(requests.at(-1)!.body).toContain(`<UpdateID>${x64.updateId}</UpdateID>`);
  });

  it('refuses a location set without the file\'s SHA-1 and a link off Microsoft\'s delivery hosts', async () => {
    const pkg: StorePackageFile = {
      numericId: 1, packageFullName: 'SpotifyAB.SpotifyMusic_1.310.2586.0_x64__zpdnekdrzrea0', packageIdentityName: 'SpotifyAB.SpotifyMusic',
      fileName: 'x.appx', size: 1, sha1: 'd321ba83468ac9975ed3be215642cd0ff39a09f7', sha256: null, modified: null, createdAt: null, mainPackage: true,
      updateId: '094f56f7-6fce-4e8d-8a09-b70fdcefcb16', revision: 1,
    };
    const unknown = await recordedTransport({ fileUrl: await fixture('extended-update-info2-unknown.response.xml') });
    await expect(resolveDownload(unknown.transport, pkg, NOW)).rejects.toThrow(Fe3Error);
    const elsewhere = (await fixture('extended-update-info2.response.xml')).replaceAll('tlu.dl.delivery.mp.microsoft.com', 'downloads.example.com');
    const moved = await recordedTransport({ fileUrl: elsewhere });
    await expect(resolveDownload(moved.transport, pkg, NOW)).rejects.toThrow(/not on Microsoft's delivery hosts/);
  });

  it('turns SOAP faults into errors that name the reason', async () => {
    expect(() => parseCookie(`${'x'}`)).toThrow();
    await expect(fixture('fault-invalid-security.response.xml').then(xml => parseCookie(xml, 500))).rejects.toThrow(/InvalidSecurity.*verifying security/);
    const { transport } = await recordedTransport({ sync: [await fixture('fault-invalid-cookie.response.xml')] });
    await expect(listStorePackages(transport, anchors, NOW)).rejects.toThrow(/InvalidCookie/);
  });

  it('notes an answer without any Spotify package', async () => {
    const { transport } = await recordedTransport({ sync: [await fixture('sync-round4.response.xml')] });
    const listing = await listStorePackages(transport, anchors, NOW);
    expect(listing.packages).toEqual([]);
    expect(listing.notes.join()).toMatch(/no SpotifyAB\.SpotifyMusic package/);
  });
});
