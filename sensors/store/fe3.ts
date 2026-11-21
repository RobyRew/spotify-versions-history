/**
 * Windows Update's delivery service (FE3), the channel a Windows PC's Store uses to download app
 * packages, read without any account:
 *  1. GetCookie;
 *  2. SyncUpdates for the product's WuCategoryId. The first answers hold only non-leaf updates
 *     (detectoids and categories); a client reports them as installed and asks again until the leaf
 *     updates, the packages, come back (three rounds on 2026-11-20);
 *  3. GetExtendedUpdateInfo2 for one package's update id, which answers with a download link valid
 *     for about 80 minutes.
 *
 * fe3.delivery.mp.microsoft.com chains to Microsoft Root Certificate Authority 2011, which is not in
 * Node's bundled roots: fe3Transport adds the pinned root (ledger/trust/anchors.json deliveryRoots)
 * to these requests only. The download host serves no valid HTTPS certificate, so the capture must
 * enforce the SHA-256 and SHA-1 this service states for the file.
 */
import { randomUUID, type X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { rootCertificates } from 'node:tls';
import type { TrustAnchors } from '../../lib/trust.ts';
import { children, escapeXml, parseXml, parseXmlFragment, textOf, type XmlElement, type XmlNode } from '../lib/xml.ts';
import { USER_AGENT } from '../lib/http.ts';

export const FE3_URL = 'https://fe3.delivery.mp.microsoft.com/ClientWebService/client.asmx';
export const FE3_SECURED_URL = `${FE3_URL}/secured`;
const ACTION = 'http://www.microsoft.com/SoftwareDistribution/Server/ClientWebService';
const MAX_ROUNDS = 6;
const MAX_RESPONSE = 32 * 1024 * 1024;

/** A Windows 11 desktop on the retail ring, as the Store client describes itself. */
export const DEVICE_ATTRIBUTES = 'BranchReadinessLevel=CB;CurrentBranch=ge_release;OEMModel=Virtual Machine;FlightRing=Retail;AttrDataVer=331;'
  + 'SystemManufacturer=Microsoft Corporation;InstallLanguage=en-US;OSUILocale=en-US;InstallationType=Client;FlightingBranchName=;'
  + 'FirmwareVersion=Hyper-V UEFI Release v4.1;SystemProductName=Virtual Machine;OSSkuId=48;FlightContent=Branch;App=WU_STORE;'
  + 'OEMName_Uncleaned=Microsoft Corporation;AppVer=10.0.26100.4202;OSArchitecture=AMD64;SystemSKU=None;UpdateManagementGroup=2;'
  + 'IsFlightingEnabled=0;IsDeviceRetailDemo=0;TelemetryLevel=1;OSVersion=10.0.26100.4202;DeviceFamily=Windows.Desktop;';

export interface Fe3Transport {
  post(url: string, body: string): Promise<{ status: number; body: string }>;
}

/** POSTs over node:https, trusting Node's bundled roots plus `roots`, with a timeout and a size cap. */
export function fe3Transport(roots: readonly X509Certificate[], timeoutMs = 60_000): Fe3Transport {
  const ca = [...rootCertificates, ...roots.map(root => root.toString())];
  return {
    post: (url, body) => new Promise((resolve, reject) => {
      const request = httpsRequest(url, {
        method: 'POST', ca, timeout: timeoutMs,
        headers: { 'content-type': 'application/soap+xml; charset=utf-8', 'user-agent': USER_AGENT, 'content-length': Buffer.byteLength(body) },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE) { request.destroy(new Error(`${url}: answer larger than ${MAX_RESPONSE} bytes`)); return; }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        response.on('error', reject);
      });
      request.on('timeout', () => request.destroy(new Error(`${url}: no answer within ${timeoutMs} ms`)));
      request.on('error', reject);
      request.end(body);
    }),
  };
}

const stamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, '.000Z');

function envelope(action: string, to: string, now: Date, body: string): string {
  return `<s:Envelope xmlns:a="http://www.w3.org/2005/08/addressing" xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header>`
    + `<a:Action s:mustUnderstand="1">${ACTION}/${action}</a:Action><a:MessageID>urn:uuid:${randomUUID()}</a:MessageID>`
    + `<a:To s:mustUnderstand="1">${to}</a:To>`
    + `<o:Security s:mustUnderstand="1" xmlns:o="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">`
    // The service refuses a timestamp whose Expires is not after Created (HTTP 500 InvalidSecurity).
    + `<Timestamp xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><Created>${stamp(now)}</Created><Expires>${stamp(new Date(now.getTime() + 5 * 60_000))}</Expires></Timestamp>`
    + `<wuws:WindowsUpdateTicketsToken wsu:id="ClientMSA" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd" xmlns:wuws="http://schemas.microsoft.com/msus/2014/10/WindowsUpdateAuthorization">`
    + `<TicketType Name="MSA" Version="1.0" Policy="MBI_SSL"><User/></TicketType></wuws:WindowsUpdateTicketsToken></o:Security></s:Header>`
    + `<s:Body>${body}</s:Body></s:Envelope>`;
}

export function getCookieRequest(now: Date): string {
  return envelope('GetCookie', FE3_URL, now, `<GetCookie xmlns="${ACTION}"><oldCookie/><lastChange>2015-10-21T17:01:07.1472913Z</lastChange>`
    + `<currentTime>${stamp(now)}</currentTime><protocolVersion>1.40</protocolVersion></GetCookie>`);
}

export function syncUpdatesRequest(cookie: string, categoryId: string, installed: readonly number[], now: Date): string {
  const ids = (list: readonly number[]) => list.map(id => `<int>${id}</int>`).join('');
  return envelope('SyncUpdates', FE3_URL, now, `<SyncUpdates xmlns="${ACTION}"><cookie><Expiration>2045-03-11T02:02:48Z</Expiration>`
    + `<EncryptedData>${escapeXml(cookie)}</EncryptedData></cookie><parameters><ExpressQuery>false</ExpressQuery>`
    + `<InstalledNonLeafUpdateIDs>${ids(installed)}</InstalledNonLeafUpdateIDs><OtherCachedUpdateIDs/>`
    + `<SkipSoftwareSync>false</SkipSoftwareSync><NeedTwoGroupOutOfScopeUpdates>true</NeedTwoGroupOutOfScopeUpdates>`
    + `<FilterAppCategoryIds><CategoryIdentifier><Id>${escapeXml(categoryId)}</Id></CategoryIdentifier></FilterAppCategoryIds>`
    + `<TreatAppCategoryIdsAsInstalled>true</TreatAppCategoryIdsAsInstalled><AlsoPerformRegularSync>false</AlsoPerformRegularSync><ComputerSpec/>`
    + `<ExtendedUpdateInfoParameters><XmlUpdateFragmentTypes><XmlUpdateFragmentType>Extended</XmlUpdateFragmentType></XmlUpdateFragmentTypes>`
    + `<Locales><string>en-US</string><string>en</string></Locales></ExtendedUpdateInfoParameters>`
    + `<ClientPreferredLanguages><string>en-US</string></ClientPreferredLanguages><ProductsParameters><SyncCurrentVersionOnly>false</SyncCurrentVersionOnly>`
    + `<DeviceAttributes>${escapeXml(DEVICE_ATTRIBUTES)}</DeviceAttributes><CallerAttributes>Interactive=1;IsSeeker=0;</CallerAttributes><Products/>`
    + `</ProductsParameters></parameters></SyncUpdates>`);
}

export function fileUrlRequest(updateId: string, revision: number, now: Date): string {
  return envelope('GetExtendedUpdateInfo2', FE3_SECURED_URL, now, `<GetExtendedUpdateInfo2 xmlns="${ACTION}"><updateIDs><UpdateIdentity>`
    + `<UpdateID>${escapeXml(updateId)}</UpdateID><RevisionNumber>${revision}</RevisionNumber></UpdateIdentity></updateIDs>`
    + `<infoTypes><XmlUpdateFragmentType>FileUrl</XmlUpdateFragmentType><XmlUpdateFragmentType>FileDecryption</XmlUpdateFragmentType></infoTypes>`
    + `<deviceAttributes>${escapeXml(DEVICE_ATTRIBUTES)}</deviceAttributes></GetExtendedUpdateInfo2>`);
}

export class Fe3Error extends Error {
  override name = 'Fe3Error';
}

/** Every element below `parent` with this local name, depth first. */
function descendants(parent: XmlElement, localName: string): XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (element: XmlElement) => {
    for (const child of children(element)) {
      if (child.localName === localName) found.push(child);
      visit(child);
    }
  };
  visit(parent);
  return found;
}

const one = (parent: XmlElement, localName: string, what: string): XmlElement => {
  const found = descendants(parent, localName);
  if (found.length !== 1) throw new Fe3Error(`${what}: expected one <${localName}>, found ${found.length}`);
  return found[0]!;
};

/** The one direct child with this local name (an UpdateInfo also holds a Deployment with its own <ID>). */
const child = (parent: XmlElement, localName: string, what: string): XmlElement => {
  const found = children(parent, localName);
  if (found.length !== 1) throw new Fe3Error(`${what}: expected one <${localName}> child, found ${found.length}`);
  return found[0]!;
};

/** The SOAP body of an answer; a Fault becomes an Fe3Error naming its reason. */
export function soapBody(xml: string, status: number, what: string): XmlElement {
  const root = parseXml(xml).root;
  if (root.localName !== 'Envelope') throw new Fe3Error(`${what}: expected a SOAP envelope, found <${root.name}> (HTTP ${status})`);
  const body = one(root, 'Body', what);
  const fault = children(body, 'Fault')[0];
  if (fault) {
    const reason = descendants(fault, 'Text').map(textOf).join(' ') || 'no reason given';
    const codes = descendants(fault, 'Value').map(textOf).join(' / ');
    throw new Fe3Error(`${what}: SOAP fault ${codes}: ${reason} (HTTP ${status})`);
  }
  if (status !== 200) throw new Fe3Error(`${what}: HTTP ${status}`);
  return body;
}

export function parseCookie(xml: string, status = 200): string {
  const value = textOf(one(soapBody(xml, status, 'GetCookie'), 'EncryptedData', 'GetCookie')).trim();
  if (!value) throw new Fe3Error('GetCookie: empty cookie');
  return value;
}

const elementsOf = (nodes: readonly XmlNode[]) => nodes.filter((node): node is XmlElement => node.kind === 'element');

export interface SyncedUpdate {
  numericId: number;
  isLeaf: boolean;
  updateId: string;
  revision: number;
}

export interface PackageFileInfo {
  numericId: number;
  packageFullName: string;
  packageIdentityName: string | null;
  fileName: string;
  size: number;
  sha1: string;
  sha256: string | null;
  modified: string | null;
  createdAt: string | null;
  mainPackage: boolean;
}

const base64Hex = (value: string, bytes: number, what: string): string => {
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== bytes || decoded.toString('base64') !== value) throw new Fe3Error(`${what}: "${value}" is not a ${bytes}-byte base64 digest`);
  return decoded.toString('hex');
};

/** UpdateInfo entries (numeric id, leaf or not, update identity) and the package files of the extended info. */
export function parseSyncUpdates(xml: string, status = 200): { updates: SyncedUpdate[]; files: PackageFileInfo[] } {
  const body = soapBody(xml, status, 'SyncUpdates');
  const updates: SyncedUpdate[] = [];
  const newUpdates = descendants(body, 'NewUpdates')[0];
  for (const info of newUpdates ? children(newUpdates, 'UpdateInfo') : []) {
    const numericId = Number(textOf(child(info, 'ID', 'UpdateInfo')));
    const isLeaf = textOf(child(info, 'IsLeaf', 'UpdateInfo')).trim() === 'true';
    const fragment = elementsOf(parseXmlFragment(textOf(child(info, 'Xml', 'UpdateInfo'))));
    const identity = fragment.find(element => element.localName === 'UpdateIdentity');
    if (!Number.isSafeInteger(numericId) || !identity?.attributes.UpdateID) throw new Fe3Error(`SyncUpdates: an UpdateInfo lacks its id or UpdateIdentity`);
    updates.push({ numericId, isLeaf, updateId: identity.attributes.UpdateID, revision: Number(identity.attributes.RevisionNumber ?? '1') });
  }
  const files: PackageFileInfo[] = [];
  const extended = descendants(body, 'ExtendedUpdateInfo')[0];
  for (const update of extended ? descendants(extended, 'Update') : []) {
    const numericId = Number(textOf(child(update, 'ID', 'Update')));
    const fragment = elementsOf(parseXmlFragment(textOf(child(update, 'Xml', 'Update'))));
    const properties = fragment.find(element => element.localName === 'ExtendedProperties');
    const install = fragment.flatMap(element => element.localName === 'HandlerSpecificData' ? descendants(element, 'AppxPackageInstallData') : [])[0];
    for (const file of fragment.flatMap(element => element.localName === 'Files' ? children(element, 'File') : [])) {
      const packageFullName = file.attributes.InstallerSpecificIdentifier;
      if (!packageFullName) continue; // the block-map cab that accompanies each package
      if (file.attributes.DigestAlgorithm !== 'SHA1' || !file.attributes.Digest || !file.attributes.FileName) throw new Fe3Error(`SyncUpdates: the file of ${packageFullName} has no SHA-1 digest or name`);
      const additional = children(file, 'AdditionalDigest').find(digest => digest.attributes.Algorithm === 'SHA256');
      const size = Number(file.attributes.Size);
      if (!Number.isSafeInteger(size) || size <= 0) throw new Fe3Error(`SyncUpdates: ${packageFullName} has the size "${file.attributes.Size}"`);
      files.push({
        numericId, packageFullName,
        packageIdentityName: properties?.attributes.PackageIdentityName ?? null,
        fileName: file.attributes.FileName,
        size,
        sha1: base64Hex(file.attributes.Digest, 20, packageFullName),
        sha256: additional ? base64Hex(textOf(additional).trim(), 32, packageFullName) : null,
        modified: file.attributes.Modified ?? null,
        createdAt: properties?.attributes.CreationDate ?? null,
        mainPackage: install?.attributes.MainPackage === 'true' && install.attributes.PackageFileName === file.attributes.FileName,
      });
    }
  }
  return { updates, files };
}

export function parseFileLocations(xml: string, status = 200): { url: string; sha1: string }[] {
  const body = soapBody(xml, status, 'GetExtendedUpdateInfo2');
  return descendants(body, 'FileLocation').map(location => ({
    url: textOf(child(location, 'Url', 'FileLocation')).trim(),
    sha1: base64Hex(textOf(child(location, 'FileDigest', 'FileLocation')).trim(), 20, 'FileLocation'),
  }));
}

export interface StorePackageFile extends PackageFileInfo {
  updateId: string;
  revision: number;
}

async function post(transport: Fe3Transport, url: string, body: string): Promise<{ status: number; body: string }> {
  return transport.post(url, body);
}

/**
 * Spotify's packages FE3 delivers now. A package counts as Spotify's only when its full name is
 * <packageIdentityName>_<version>_<arch>__<the publisher hash of the pinned package family>.
 */
export async function listStorePackages(transport: Fe3Transport, trust: TrustAnchors, now: Date): Promise<{ packages: StorePackageFile[]; others: string[]; rounds: number; notes: string[] }> {
  const anchor = trust.windowsStore;
  const publisherHash = anchor.packageFamilyName.slice(anchor.packageIdentityName.length + 1);
  const spotify = new RegExp(`^${anchor.packageIdentityName.replaceAll('.', '\\.')}_\\d+\\.\\d+\\.\\d+\\.\\d+_(x64|x86|arm64|neutral)_[^_]*_${publisherHash}$`);
  const cookieAnswer = await post(transport, FE3_URL, getCookieRequest(now));
  const cookie = parseCookie(cookieAnswer.body, cookieAnswer.status);
  const installed: number[] = [];
  const leaves = new Map<number, SyncedUpdate>();
  const files = new Map<string, PackageFileInfo>();
  const notes: string[] = [];
  let rounds = 0;
  for (; rounds < MAX_ROUNDS; rounds++) {
    const answer = await post(transport, FE3_URL, syncUpdatesRequest(cookie, anchor.wuCategoryId, installed, now));
    const parsed = parseSyncUpdates(answer.body, answer.status);
    for (const update of parsed.updates.filter(update => update.isLeaf)) leaves.set(update.numericId, update);
    for (const file of parsed.files) files.set(file.packageFullName, file);
    const fresh = parsed.updates.filter(update => !update.isLeaf && !installed.includes(update.numericId)).map(update => update.numericId);
    if (fresh.length === 0) { rounds++; break; }
    installed.push(...fresh);
  }
  const packages: StorePackageFile[] = [];
  const others: string[] = [];
  for (const file of files.values()) {
    const leaf = leaves.get(file.numericId);
    if (!leaf) { notes.push(`${file.packageFullName}: listed in the extended info without a leaf update`); continue; }
    if (!spotify.test(file.packageFullName) || file.packageIdentityName !== anchor.packageIdentityName) { others.push(file.packageFullName); continue; }
    packages.push({ ...file, updateId: leaf.updateId, revision: leaf.revision });
  }
  if (packages.length === 0) notes.push(`FE3 returned no ${anchor.packageIdentityName} package after ${rounds} round(s)`);
  return { packages: packages.sort((a, b) => a.packageFullName.localeCompare(b.packageFullName)), others: others.sort(), rounds, notes };
}

/** The short-lived download link for one package file, and when it expires (its P1 parameter). */
export async function resolveDownload(transport: Fe3Transport, pkg: StorePackageFile, now: Date): Promise<{ url: string; expiresAt: string | null; sha1: string }> {
  const answer = await post(transport, FE3_SECURED_URL, fileUrlRequest(pkg.updateId, pkg.revision, now));
  const location = parseFileLocations(answer.body, answer.status).find(candidate => candidate.sha1 === pkg.sha1);
  if (!location) throw new Fe3Error(`GetExtendedUpdateInfo2 names no location with the SHA-1 of ${pkg.packageFullName}`);
  const url = new URL(location.url);
  if (!/^https?:$/.test(url.protocol) || !/(^|\.)delivery\.mp\.microsoft\.com$/.test(url.hostname)) throw new Fe3Error(`the download link ${url.origin} is not on Microsoft's delivery hosts`);
  const expiry = Number(url.searchParams.get('P1'));
  return { url: url.href, expiresAt: Number.isSafeInteger(expiry) && expiry > 0 ? new Date(expiry * 1000).toISOString() : null, sha1: location.sha1 };
}
