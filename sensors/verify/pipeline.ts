/**
 * Captures the builds a detection run found and runs every check this host can run on them:
 *  - Linux: in-process Authenticode, Store package and OpenPGP checks, plus osslsigncode and gpgv;
 *  - macOS: the same in-process checks, plus codesign, spctl and stapler on the DMGs;
 *  - Windows: the same in-process checks, plus Get-AuthenticodeSignature and signtool.
 * Files are captured one at a time into the work directory and deleted after their checks, so a
 * runner never holds more than one build. Nothing here writes to the ledger: the result is a
 * HostReport (sensors/verify/report.ts) that the merge step combines across hosts.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { arch as osArch, release, type } from 'node:os';
import { join } from 'node:path';
import { loadCertificates, TRUST_DIRECTORY, type TrustAnchors } from '../../lib/trust.ts';
import { artifactId } from '../../lib/ledger/schema.ts';
import { captureFile, RotatedError, type CaptureRequest } from '../capture/download.ts';
import { APT_REPOSITORY, aptSuite } from '../channels/apt.ts';
import { snapAssertionKey } from '../channels/snap.ts';
import { getBytes, getText } from '../lib/http.ts';
import { readLocalPe } from '../lib/pe.ts';
import { fe3Transport, listStorePackages, resolveDownload, type Fe3Transport, type StorePackageFile } from '../store/fe3.ts';
import type { Detection, Fetch } from '../types.ts';
import { verifyAppxPackage, readAppxParts } from './appx.ts';
import { verifyAppxSignature } from './appx-signature.ts';
import { verifyAptIndex, verifyDeb, verifyInRelease } from './apt.ts';
import { verifyAuthenticode } from './authenticode.ts';
import { gpgvVerify } from './gpgv.ts';
import { verifyDmg } from './macos.ts';
import { osslsigncodeVerify } from './osslsigncode.ts';
import type { ArtifactReport, HostReport } from './report.ts';
import { verifySnapAssertions } from './snap.ts';
import { fail, pass, skip } from './types.ts';
import { verifyWindowsNative } from './windows.ts';

const VERIFIER = 'svh-verify/1';
/** Spotify's largest build is about 230 MB; anything far past that is not one of them. */
const MAX_BYTES = 640 * 1024 * 1024;
export const VERIFIABLE_SENSORS = ['windows', 'macos', 'apt', 'snap', 'store'] as const;

export interface PipelineOptions {
  fetch: Fetch;
  trust: TrustAnchors;
  now: Date;
  workDirectory: string;
  /** Sensors whose detections this host verifies. */
  only: ReadonlySet<string>;
  keepFiles?: boolean;
  runUrl?: string | null;
  log?: (message: string) => void;
  /** FE3 access for the Store; defaults to node:https with the pinned delivery roots. */
  fe3?: Fe3Transport;
  /** The host the checks run on; defaults to process.platform (tests override it). */
  host?: NodeJS.Platform;
  /** The first pause before a failed download is tried again (default 5 s; tests pass 0). */
  retryWaitMs?: number;
}

interface Context extends PipelineOptions {
  host: NodeJS.Platform;
  log: (message: string) => void;
  roots: { windows: RootFiles; store: RootFiles };
  storePackages: Promise<StorePackageFile[]> | null;
}

interface RootFiles {
  certificates: Awaited<ReturnType<typeof loadCertificates>>;
  timestampCertificates: Awaited<ReturnType<typeof loadCertificates>>;
  /** PEM files for external tools: the signature roots and the timestamp roots. */
  caFile: string;
  tsaCaFile: string;
}

async function rootFiles(trust: TrustAnchors, roots: readonly string[], timestampRoots: readonly string[], directory: string, name: string): Promise<RootFiles> {
  const certificates = await loadCertificates(trust, roots);
  const timestampCertificates = await loadCertificates(trust, timestampRoots);
  const caFile = join(directory, `${name}-roots.pem`);
  const tsaCaFile = join(directory, `${name}-timestamp-roots.pem`);
  await writeFile(caFile, certificates.map(certificate => certificate.toString()).join('\n'));
  await writeFile(tsaCaFile, timestampCertificates.map(certificate => certificate.toString()).join('\n'));
  return { certificates, timestampCertificates, caFile, tsaCaFile };
}

function baseReport(detection: Detection): ArtifactReport {
  return {
    key: artifactId(detection.fullVersion ?? detection.version, detection.platform, detection.arch, detection.format),
    sensor: detection.sensor, product: detection.product,
    version: detection.version, fullVersion: detection.fullVersion,
    platform: detection.platform, arch: detection.arch, format: detection.format,
    source: null, file: null, checks: [],
  };
}

/** A signed Store link without its query string: the P1-P4 parameters expire and are not worth keeping. */
function withoutQuery(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  return parsed.href;
}

/**
 * A failure worth one more try: the connection dropped or timed out ("fetch failed" from undici, an
 * abort, a reset). A file that changed, a digest or size that does not match, or an HTTP refusal is
 * an answer, not a hiccup, and is reported at once. A snap download failing this way failed the
 * whole day's run on 2026-11-23.
 */
export function isTransientFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const text = `${error.message} ${(error as { cause?: { code?: string; message?: string } }).cause?.code ?? ''} ${(error as { cause?: { message?: string } }).cause?.message ?? ''}`;
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_|socket hang up|other side closed|terminated/i.test(text);
}

const CAPTURE_ATTEMPTS = 3;

async function capture(context: Context, report: ArtifactReport, request: Omit<CaptureRequest, 'maxBytes'>): Promise<string> {
  let captured: Awaited<ReturnType<typeof captureFile>> | null = null;
  for (let attempt = 1; !captured; attempt++) {
    try {
      captured = await captureFile(context.fetch, { ...request, maxBytes: MAX_BYTES });
    } catch (error) {
      if (attempt >= CAPTURE_ATTEMPTS || !isTransientFailure(error)) throw error;
      context.log(`${report.key}: download attempt ${attempt} failed (${(error as Error).message}); trying again`);
      await new Promise(resolve => setTimeout(resolve, (context.retryWaitMs ?? 5000) * attempt));
    }
  }
  report.source = { url: report.source?.url ?? request.url, finalUrl: captured.finalUrl ?? null, etag: captured.etag, lastModified: captured.lastModified };
  report.file = { size: captured.size, ...captured.digests };
  report.checks.push(...captured.checks);
  context.log(`${report.key}: captured ${captured.size} bytes, sha256 ${captured.digests.sha256}`);
  return captured.path;
}

async function windowsChecks(context: Context, detection: Detection, report: ArtifactReport): Promise<void> {
  if (!detection.url) throw new Error('the detection has no URL');
  report.source = { url: detection.url, finalUrl: null, etag: detection.etag ?? null, lastModified: detection.lastModified ?? null };
  const path = await capture(context, report, {
    url: detection.url, destination: join(context.workDirectory, `${report.key}.exe`),
    expectedSize: detection.size, ifMatch: detection.etag ?? null, claimed: detection.claimed,
  });
  try {
    const pe = await readLocalPe(path);
    report.checks.push(pe.arch === detection.arch && pe.productVersion === detection.fullVersion
      ? pass('pe.identity', VERIFIER, `${pe.arch} ProductVersion ${pe.productVersion}`)
      : fail('pe.identity', VERIFIER, `expected ${detection.arch} ${detection.fullVersion}, found ${pe.arch ?? `machine 0x${pe.machine.toString(16)}`} ${pe.productVersion}`));
    const roots = context.roots.windows;
    report.checks.push(...await verifyAuthenticode(path, context.trust, { roots: roots.certificates, timestampRoots: roots.timestampCertificates }));
    if (context.host === 'win32') report.checks.push(...await verifyWindowsNative(path, context.trust, 'pe'));
    else report.checks.push(...await osslsigncodeVerify(path, roots.caFile, roots.tsaCaFile));
  } finally {
    if (!context.keepFiles) await rm(path, { force: true });
  }
}

async function macosChecks(context: Context, detection: Detection, report: ArtifactReport): Promise<void> {
  if (!detection.url) throw new Error('the detection has no URL');
  report.source = { url: detection.url, finalUrl: null, etag: detection.etag ?? null, lastModified: detection.lastModified ?? null };
  const path = await capture(context, report, {
    url: detection.url, destination: join(context.workDirectory, `${report.key}.dmg`),
    expectedSize: detection.size, ifMatch: detection.etag ?? null, claimed: detection.claimed,
  });
  try {
    if (context.host === 'darwin') report.checks.push(...await verifyDmg(path, context.trust, { version: detection.version }));
    else report.checks.push(skip('macos.signature', VERIFIER, 'codesign, spctl and stapler run on the macOS host'));
  } finally {
    if (!context.keepFiles) await rm(path, { force: true });
  }
}

async function aptChecks(context: Context, detection: Detection, report: ArtifactReport): Promise<void> {
  const suite = String(detection.meta.suite ?? '');
  if (!suite || !detection.url) throw new Error('the detection names no apt suite or URL');
  const inRelease = await getBytes(context.fetch, `${APT_REPOSITORY}/dists/${suite}/InRelease`);
  const packages = await getBytes(context.fetch, `${APT_REPOSITORY}/dists/${suite}/non-free/binary-amd64/Packages`);
  const keys = await Promise.all(context.trust.apt.keys.map(async key => ({ fingerprint: key.fingerprint, key: new Uint8Array(await readFile(join(TRUST_DIRECTORY, key.file))) })));
  report.checks.push(...verifyInRelease(inRelease, keys, context.now));
  report.checks.push(...verifyAptIndex(suite, inRelease, packages));
  const inReleaseFile = join(context.workDirectory, `${suite}-InRelease`);
  await writeFile(inReleaseFile, inRelease);
  // One keyring with every pinned key (binary key files concatenate), so a rotation with two pinned keys passes on either.
  const keyring = join(context.workDirectory, 'apt-pinned-keys.gpg');
  await writeFile(keyring, Buffer.concat(keys.map(key => key.key)));
  report.checks.push(...await gpgvVerify(inReleaseFile, keyring));
  // The index just checked must still list this exact file; the detection may be from an older index.
  const listed = aptSuite(suite, inRelease, packages).detections.find(candidate => candidate.url === detection.url);
  if (!listed) {
    report.rotated = true;
    report.checks.push(skip('apt.listing', VERIFIER, `${suite} no longer lists ${detection.url}`));
    return;
  }
  if (listed.claimed.sha256 !== detection.claimed.sha256) {
    report.checks.push(fail('apt.listing', VERIFIER, `${detection.url} is listed with sha256 ${listed.claimed.sha256}, the detection had ${detection.claimed.sha256}`));
  }
  report.source = { url: detection.url, finalUrl: null, etag: null, lastModified: null };
  const path = await capture(context, report, {
    url: detection.url, destination: join(context.workDirectory, `${report.key}.deb`),
    expectedSize: listed.size, claimed: listed.claimed,
  });
  try {
    report.checks.push(...await verifyDeb(path, {
      sha256: listed.claimed.sha256 ?? '', size: listed.size ?? 0, package: 'spotify-client',
      version: String(listed.meta.debVersion ?? ''), architecture: 'amd64',
    }));
  } finally {
    if (!context.keepFiles) await rm(path, { force: true });
  }
}

const ASSERTIONS = 'https://assertions.ubuntu.com/v1/assertions';

async function assertion(context: Context, path: string): Promise<string> {
  return getText(context.fetch, `${ASSERTIONS}/${path}`, { headers: { accept: 'application/x.ubuntu.assertion' } });
}

async function snapChecks(context: Context, detection: Detection, report: ArtifactReport): Promise<void> {
  const sha3 = detection.claimed.sha3_384;
  if (!sha3 || !detection.url) throw new Error('the detection has no sha3-384 or URL');
  report.source = { url: detection.url, finalUrl: null, etag: null, lastModified: null };
  const path = await capture(context, report, {
    url: detection.url, destination: join(context.workDirectory, `${report.key}.snap`),
    expectedSize: detection.size, claimed: detection.claimed,
  });
  try {
    const revision = await assertion(context, `snap-revision/${snapAssertionKey(sha3)}`);
    const signKey = /^sign-key-sha3-384: (\S+)$/m.exec(revision)?.[1];
    if (!signKey) {
      report.checks.push(fail('snap.assertion-chain', VERIFIER, 'the snap-revision assertion names no sign-key-sha3-384'));
      return;
    }
    const accountKey = await assertion(context, `account-key/${signKey}`);
    const declaration = await assertion(context, `snap-declaration/16/${context.trust.snap.snapId}`);
    const root = await readFile(join(TRUST_DIRECTORY, context.trust.snap.rootKey.file), 'utf8');
    report.checks.push(...verifySnapAssertions([revision, accountKey, declaration].join('\n'), context.trust, root, { sha3_384: report.file!.sha3_384, size: report.file!.size }, context.now));
  } finally {
    if (!context.keepFiles) await rm(path, { force: true });
  }
}

async function storeChecks(context: Context, detection: Detection, report: ArtifactReport): Promise<void> {
  const name = String(detection.meta.packageFullName ?? '');
  context.storePackages ??= (async () => {
    const transport = context.fe3 ?? fe3Transport(await loadCertificates(context.trust, context.trust.windowsStore.deliveryRoots));
    context.fe3 = transport;
    const listing = await listStorePackages(transport, context.trust, context.now);
    for (const note of listing.notes) context.log(`store: ${note}`);
    return listing.packages;
  })();
  const pkg = (await context.storePackages).find(candidate => candidate.packageFullName === name);
  if (!pkg) {
    report.checks.push(fail('store.delivery', VERIFIER, `FE3 offers no package ${name}, which displaycatalog lists`));
    return;
  }
  if (detection.claimed.sha256 && pkg.sha256) {
    report.checks.push(detection.claimed.sha256 === pkg.sha256
      ? pass('store.catalog-digest', VERIFIER, `displaycatalog and FE3 state sha256 ${pkg.sha256}`)
      : fail('store.catalog-digest', VERIFIER, `displaycatalog states sha256 ${detection.claimed.sha256}, FE3 ${pkg.sha256}`));
  }
  const download = await resolveDownload(context.fe3!, pkg, context.now);
  report.source = { url: withoutQuery(download.url), finalUrl: null, etag: null, lastModified: null };
  const sha256 = pkg.sha256 ?? detection.claimed.sha256;
  if (!sha256) throw new Error(`neither FE3 nor displaycatalog states a SHA-256 for ${name}`);
  const path = await capture(context, report, {
    url: download.url, destination: join(context.workDirectory, `${report.key}.${detection.format}`),
    expectedSize: pkg.size, claimed: { sha1: pkg.sha1, sha256 }, allowHttp: true,
  });
  if (report.source) report.source.finalUrl = report.source.finalUrl ? withoutQuery(report.source.finalUrl) : null;
  try {
    report.checks.push(...await verifyAppxPackage(path, context.trust, { version: String(detection.meta.storeVersion ?? ''), arch: detection.arch }));
    const parts = await readAppxParts(path);
    const roots = context.roots.store;
    report.checks.push(...verifyAppxSignature(parts.signature, parts, context.trust, { roots: roots.certificates, timestampRoots: roots.timestampCertificates }));
    if (context.host === 'win32') report.checks.push(...await verifyWindowsNative(path, context.trust, 'appx'));
    // osslsigncode's OpenSSL chain check stops at the critical Application Policies extension
    // (1.3.6.1.4.1.311.21.10) of every Store signing certificate ("unhandled critical extension",
    // run 44891684343), so for packages the second implementation is the Windows host's.
    else report.checks.push(skip('osslsigncode.verify', 'osslsigncode', 'not run on Store packages: OpenSSL refuses the critical Application Policies extension of Microsoft\'s Store signing certificates; the Windows host checks the package natively'));
  } finally {
    if (!context.keepFiles) await rm(path, { force: true });
  }
}

const HANDLERS: Record<string, (context: Context, detection: Detection, report: ArtifactReport) => Promise<void>> = {
  windows: windowsChecks, macos: macosChecks, apt: aptChecks, snap: snapChecks, store: storeChecks,
};

export async function runPipeline(detections: readonly Detection[], options: PipelineOptions): Promise<HostReport> {
  await mkdir(options.workDirectory, { recursive: true });
  const trust = options.trust;
  const context: Context = {
    ...options,
    host: options.host ?? process.platform,
    log: options.log ?? (() => {}),
    roots: {
      windows: await rootFiles(trust, trust.windows.authenticode.roots, trust.windows.authenticode.timestampRoots, options.workDirectory, 'windows'),
      store: await rootFiles(trust, trust.windowsStore.signingRoots, trust.windowsStore.timestampRoots, options.workDirectory, 'store'),
    },
    storePackages: null,
  };
  const artifacts: ArtifactReport[] = [];
  const seen = new Set<string>();
  for (const detection of detections) {
    const handler = HANDLERS[detection.sensor];
    if (!handler || !options.only.has(detection.sensor)) continue;
    const report = baseReport(detection);
    // The snap channel map lists a revision once per channel; one capture per artifact is enough.
    if (seen.has(report.key)) continue;
    seen.add(report.key);
    try {
      await handler(context, detection, report);
    } catch (error) {
      if (error instanceof RotatedError) {
        report.rotated = true;
        report.checks.push(skip('capture.if-match', VERIFIER, error.message));
      } else {
        report.error = error instanceof Error ? error.message : String(error);
        context.log(`${report.key}: ${report.error}`);
      }
    }
    artifacts.push(report);
  }
  return {
    schema: 1,
    host: context.host,
    hostDetail: `${type()} ${release()} ${osArch()}, Node ${process.version}`,
    generatedAt: options.now.toISOString(),
    run: options.runUrl ?? null,
    artifacts,
  };
}
