// Release watcher with two independent sensors (see docs/SPOTIFY_DOWNLOADS.md):
//  1. Spotify's permanent installer URLs, the only unauthenticated links Spotify publishes, which
//     rotate to the new build at release time. A changed ETag means a new build: the file is
//     downloaded from Spotify with If-Match and its PE ProductVersion, SHA-256 and SHA-1 recorded.
//  2. Optionally, Spotify's desktop update service (probe-update-service.py, needs stored session
//     credentials), which answers with the current build's version, Spotify's http_prefix and its
//     own binary_hash of the file. Both sensors land in the same record per build, keyed by hash:
//     a build seen by both is marked verified when Spotify's hash matches the downloaded file, and
//     flagged as a conflict when it does not.
// Records live in site/data/official.json. When ARCHIVE_RELEASE_TAG is set, each captured file is
// attached to that GitHub release under the stable spotify_installer-<version>-<arch>.exe name.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rename, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WATCHED = [
  { id: 'windows-x64', url: 'https://download.scdn.co/SpotifyFullSetupX64.exe', platform: 'windows', architecture: 'x64', machine: 0x8664 },
  { id: 'windows-arm64', url: 'https://download.scdn.co/SpotifyFullSetupARM64.exe', platform: 'windows', architecture: 'arm64', machine: 0xAA64 },
  { id: 'windows-x86', url: 'https://download.scdn.co/SpotifyFullSetup.exe', platform: 'windows', architecture: 'x86', machine: 0x14c },
  { id: 'windows-online', url: 'https://download.scdn.co/SpotifySetup.exe' },
  { id: 'macos-x64', url: 'https://download.scdn.co/Spotify.dmg' },
  { id: 'macos-arm64', url: 'https://download.scdn.co/SpotifyARM64.dmg' },
];
const versionPattern = /^1\.\d{1,5}\.\d{1,5}\.\d{1,8}\.g[0-9a-f]{8,40}$/i;

/** Reads machine type and the VS_VERSIONINFO ProductVersion string from a PE image. */
export function inspectPortableExecutable(buffer) {
  if (buffer.length < 0x40 || buffer.toString('latin1', 0, 2) !== 'MZ') throw new Error('Not a Windows executable');
  const pe = buffer.readUInt32LE(0x3C);
  if (pe + 24 > buffer.length || buffer.readUInt32LE(pe) !== 0x00004550) throw new Error('Missing PE header');
  const machine = buffer.readUInt16LE(pe + 4);
  const key = Buffer.from('ProductVersion\0', 'utf16le');
  const at = buffer.indexOf(key);
  if (at < 0) throw new Error('No ProductVersion resource');
  let offset = at + key.length;
  while (offset + 1 < buffer.length && buffer.readUInt16LE(offset) === 0) offset += 2;
  let end = offset;
  while (end + 1 < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
  const productVersion = buffer.toString('utf16le', offset, end).trim();
  if (!versionPattern.test(productVersion)) throw new Error(`Unexpected ProductVersion ${JSON.stringify(productVersion)}`);
  return { machine, productVersion };
}

function headers(response) {
  const size = Number(response.headers.get('content-length'));
  const modified = response.headers.get('last-modified');
  return {
    etag: response.headers.get('etag') ?? null,
    size: Number.isSafeInteger(size) && size > 0 ? size : null,
    lastModified: modified && Number.isFinite(Date.parse(modified)) ? new Date(modified).toISOString() : null,
  };
}

export async function probe(target, fetchImpl = fetch) {
  const response = await fetchImpl(target.url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  await response.body?.cancel();
  if (response.status !== 200) throw new Error(`${target.url}: HTTP ${response.status}`);
  const head = headers(response);
  if (!head.etag || !head.size) throw new Error(`${target.url}: no ETag or size`);
  return head;
}

/**
 * Downloads one installer and reads its identity from the bytes. A permanent URL is fetched with
 * If-Match so a build that rotates mid-run fails (412) instead of being mislabeled; a signed
 * update-service link is fetched as is. The whole file is hashed (SHA-256 and SHA-1, the latter
 * for comparison with Spotify's binary_hash whatever its algorithm turns out to be).
 */
export async function capture(target, { url = target.url, etag = null, size = null, expectVersion = null } = {}, directory, fetchImpl = fetch) {
  const path = join(directory, target.id + '.exe');
  const response = await fetchImpl(url, { redirect: 'error', headers: etag ? { 'If-Match': etag } : {}, signal: AbortSignal.timeout(15 * 60_000) });
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(`${url}: HTTP ${response.status} during download`); }
  const head = headers(response);
  const expected = size ?? head.size;
  const sha256 = createHash('sha256'), sha1 = createHash('sha1');
  let bytes = 0;
  await pipeline(Readable.fromWeb(response.body), async function* (source) { for await (const chunk of source) { sha256.update(chunk); sha1.update(chunk); bytes += chunk.length; yield chunk; } }, createWriteStream(path));
  if (expected && bytes !== expected) throw new Error(`${url}: received ${bytes} of ${expected} bytes`);
  const handle = await open(path, 'r');
  let image;
  try {
    // The version resource sits in .rsrc near the end of Spotify's installer; the whole file is small enough to scan.
    image = await handle.readFile();
  } finally { await handle.close(); }
  const { machine, productVersion } = inspectPortableExecutable(image);
  if (machine !== target.machine) throw new Error(`${url}: machine 0x${machine.toString(16)} is not ${target.architecture}`);
  if (expectVersion && expectVersion.toLowerCase() !== productVersion.toLowerCase()) throw new Error(`${url}: file is ${productVersion}, not ${expectVersion}`);
  // A release asset takes the local file's name, so the file is named after the build before any upload.
  const name = `spotify_installer-${productVersion}-${target.architecture}.exe`;
  const named = join(directory, name);
  await rename(path, named);
  return { path: named, sha256: sha256.digest('hex'), sha1: sha1.digest('hex'), size: bytes, lastModified: head.lastModified, etag: head.etag, fullVersion: productVersion, name };
}

/** Attaches a captured file to the rolling release. Returns the asset URL, or null when archiving is off. */
export function archive(file, tag, repository, { run = spawnSync } = {}) {
  if (!tag) return null;
  if (basename(file.path) !== file.name) throw new Error(`archive: ${file.path} must be named ${file.name}`);
  const result = run('gh', ['release', 'upload', tag, file.path, '--repo', repository, '--clobber'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`gh release upload exited with ${result.status}`);
  return `https://github.com/${repository}/releases/download/${tag}/${file.name}`;
}

export function ensureRelease(tag, repository, { run = spawnSync } = {}) {
  if (!tag) return;
  if (run('gh', ['release', 'view', tag, '--repo', repository], { stdio: 'ignore' }).status === 0) return;
  const notes = 'Spotify installers downloaded by this repository\'s CI from download.scdn.co at release time. ' +
    'Each asset\'s SHA-256, ETag and capture date are listed in site/data/official.json and on the Pages catalog.';
  const result = run('gh', ['release', 'create', tag, '--repo', repository, '--title', 'Spotify installers (CI copies)', '--notes', notes, '--latest=false'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`gh release create exited with ${result.status}`);
}

/** Pure state transition: heads replace the watched section; captured builds are merged by hash. */
export function applyObservations(previous, heads, captures, checkedAt) {
  const watched = { ...(previous?.watched ?? {}) };
  for (const [id, head] of Object.entries(heads)) {
    const before = watched[id] ?? {};
    watched[id] = { ...head, checkedAt, changedAt: before.etag === head.etag ? before.changedAt ?? checkedAt : checkedAt };
  }
  // Deep copies: later steps update records in place, and change detection compares against `previous`.
  const builds = (previous?.builds ?? []).map(build => structuredClone(build));
  for (const build of captures) {
    const index = builds.findIndex(b => b.sha256 === build.sha256);
    if (index >= 0) builds[index] = { ...builds[index], ...build, capturedAt: builds[index].capturedAt, sensors: [...new Set([...(builds[index].sensors ?? []), ...(build.sensors ?? [])])] };
    else builds.unshift(build);
  }
  builds.sort((a, b) => Date.parse(b.lastModified) - Date.parse(a.lastModified) || a.architecture.localeCompare(b.architecture));
  return { schemaVersion: 1, watched, ...(previous?.updateService ? { updateService: structuredClone(previous.updateService) } : {}), builds };
}

/** Fixed key order for the file, so a run that learned nothing new writes byte-identical JSON. */
export function serialize(state) {
  const ordered = { schemaVersion: state.schemaVersion, watched: state.watched, ...(state.updateService ? { updateService: state.updateService } : {}), builds: state.builds };
  return JSON.stringify(ordered, null, 2) + '\n';
}

/** Change detection ignores when a check ran and any key order; only observations count. */
export function canonical(state) {
  const strip = value => Array.isArray(value) ? value.map(strip)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => key !== 'checkedAt').map(key => [key, strip(value[key])]))
    : value;
  return JSON.stringify(strip(state));
}

/**
 * Pure part of the second sensor. For each Windows offer, the matching build (same version and
 * architecture) gets Spotify's http_prefix and binary_hash; the record is verified when that hash
 * equals the downloaded file's SHA-256 or SHA-1, and a conflict otherwise. Offers for builds not
 * captured yet are returned so the caller can download them from the signed link while it lasts.
 */
export function reconcileUpdateService(state, probe, checkedAt) {
  const offers = { ...(state.updateService?.offers ?? {}) };
  const missing = [];
  for (const [platform, result] of Object.entries(probe?.results ?? {})) {
    if (!result?.fullVersion || !result.httpPrefix) continue;
    const before = offers[platform];
    const changed = before?.fullVersion !== result.fullVersion || before?.httpPrefix !== result.httpPrefix || before?.binaryHash !== result.binaryHash;
    // poll_interval is jittered per response and left out, so an unchanged offer stays byte-identical.
    // The signed link is a fresh token every response; it is kept until a week before it expires.
    const signed = signedLink(changed ? null : before, result, checkedAt);
    offers[platform] = { fullVersion: result.fullVersion, os: result.os, architecture: result.architecture, httpPrefix: result.httpPrefix,
      binaryHash: result.binaryHash, targetVersion: result.targetVersion, upgradeType: result.upgradeType, seenAt: changed ? checkedAt : before.seenAt, ...signed };
    if (result.os !== 'windows') continue;
    const build = state.builds.find(b => b.platform === 'windows' && b.architecture === result.architecture && b.fullVersion.toLowerCase() === result.fullVersion.toLowerCase());
    if (!build) { missing.push(result); continue; }
    const hash = (result.binaryHash ?? '').toLowerCase();
    const matches = hash.length > 0 && (hash === build.sha256 || hash === build.sha1);
    build.updateService = { httpPrefix: result.httpPrefix, binaryHash: result.binaryHash, targetVersion: result.targetVersion,
      seenAt: build.updateService?.seenAt ?? checkedAt, ...signedLink(build.updateService, result, checkedAt) };
    build.sensors = [...new Set([...(build.sensors ?? ['permanent-url']), 'update-service'])];
    if (matches) { build.verified = 'binary_hash'; delete build.conflict; }
    else if (hash) build.conflict = `Spotify's binary_hash ${hash} matches neither sha256 nor sha1 of the file downloaded from ${build.url}`;
  }
  state.updateService = { claim: probe?.claim ?? null, checkedAt, offers };
  return missing;
}

/**
 * Where a recorded build can still be fetched for the archive, best source first: Spotify's permanent
 * URL while its ETag is the one recorded, the update service's signed link (valid 30 days), then the
 * mirror's stable filename. Whatever the source, the upload happens only if the bytes hash to the
 * SHA-256 CI recorded from Spotify, so an archive copy is always Spotify's file.
 */
export function archiveCandidates(build, heads, probe) {
  const watched = build.platform === 'windows' ? WATCHED.find(w => w.platform === 'windows' && w.architecture === build.architecture) : null;
  if (!watched) return { watched: null, candidates: [] };
  const candidates = [];
  if (heads[watched.id]?.etag === build.etag) candidates.push({ url: watched.url, etag: build.etag, size: build.size });
  const offer = Object.values(probe?.results ?? {}).find(r => r?.os === 'windows' && r.architecture === build.architecture && r.fullVersion?.toLowerCase() === build.fullVersion.toLowerCase());
  if (offer?.url) candidates.push({ url: offer.url, size: build.size });
  candidates.push({ url: `https://loadspot.amd64fox1.workers.dev/download/spotify_installer-${build.fullVersion}-${build.architecture}.exe`, size: build.size });
  return { watched, candidates };
}

function signedLink(previous, result, checkedAt) {
  const keep = previous?.signedUrl && previous.signedUntil && Date.parse(previous.signedUntil) - Date.parse(checkedAt) > 7 * 86_400_000;
  if (keep) return { signedUrl: previous.signedUrl, signedUntil: previous.signedUntil };
  return result.url && result.signedUntil ? { signedUrl: result.url, signedUntil: result.signedUntil } : {};
}

/** A recorded archive link must still answer; a dead one is dropped so the backfill replaces it. */
export async function archiveAlive(url, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(20_000) });
    await response.body?.cancel();
    return response.status === 200;
  } catch { return false; }
}

/** Runs the Python probe when credentials are configured; null when skipped or unusable. */
export function runProbe({ run = spawnSync, env = process.env } = {}) {
  if (!env.SPOTIFY_CREDENTIALS && !env.SPOTIFY_CREDENTIALS_FILE) return null;
  const script = new URL('./probe-update-service.py', import.meta.url).pathname;
  const result = run('python3', [script], { encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) { console.warn(`update-service probe exited with ${result.status}: ${result.stderr?.slice(-500)}`); return null; }
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed.skipped) { console.warn(`update-service probe skipped: ${parsed.reason}`); return null; }
    return parsed;
  } catch (error) { console.warn(`update-service probe returned no JSON: ${error.message}`); return null; }
}

async function main() {
  const target = new URL('../data/official.json', import.meta.url);
  const repository = process.env.GITHUB_REPOSITORY ?? 'RobyRew/spotify-versions-history';
  const tag = process.env.ARCHIVE_RELEASE_TAG || '';
  let previous = null;
  try { previous = JSON.parse(await readFile(target, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const checkedAt = new Date().toISOString();
  const heads = {};
  const failures = [];
  for (const watched of WATCHED) {
    try { heads[watched.id] = await probe(watched); }
    catch (error) { failures.push(error.message); }
  }
  if (Object.keys(heads).length === 0) throw new Error(`No permanent URL answered: ${failures.join('; ')}`);
  const changed = WATCHED.filter(w => w.machine && heads[w.id] && heads[w.id].etag !== previous?.watched?.[w.id]?.etag);
  const captures = [];
  const directory = await mkdtemp(join(tmpdir(), 'spotify-official-'));
  const record = (watched, file, extra) => {
    ensureRelease(tag, repository);
    const asset = archive(file, tag, repository);
    const build = { fullVersion: file.fullVersion, platform: watched.platform, architecture: watched.architecture, sha256: file.sha256, sha1: file.sha1,
      size: file.size, lastModified: file.lastModified, capturedAt: checkedAt, ...extra, ...(asset ? { archive: asset, archivedFrom: new URL(extra.url).host } : {}) };
    captures.push(build);
    console.log(`${watched.id}: ${file.fullVersion} sha256=${file.sha256}${asset ? ` archived at ${asset}` : ''}`);
    return build;
  };
  try {
    for (const watched of changed) {
      const head = heads[watched.id];
      console.log(`${watched.id}: new ETag ${head.etag}, downloading ${head.size} bytes from ${watched.url}`);
      const file = await capture(watched, { etag: head.etag, size: head.size }, directory);
      record(watched, file, { url: watched.url, etag: head.etag, sensors: ['permanent-url'] });
    }
    const next = applyObservations(previous, heads, captures, checkedAt);
    const probe = runProbe();
    if (probe) {
      for (const offer of reconcileUpdateService(next, probe, checkedAt)) {
        const watched = WATCHED.find(w => w.platform === 'windows' && w.architecture === offer.architecture);
        if (!watched) continue;
        console.log(`${watched.id}: update service offers ${offer.fullVersion}, downloading from ${offer.httpPrefix}`);
        try {
          const file = await capture(watched, { url: offer.url, expectVersion: offer.fullVersion }, directory);
          record(watched, file, { url: offer.httpPrefix, sensors: ['update-service'] });
        } catch (error) { console.warn(`${watched.id}: ${error.message}`); }
      }
      // Builds captured from the signed link now carry Spotify's hash too.
      const merged = applyObservations(next, {}, captures, checkedAt);
      merged.updateService = next.updateService;
      reconcileUpdateService(merged, probe, checkedAt);
      Object.assign(next, merged);
    }
    for (const build of next.builds.filter(b => b.archive)) {
      if (await archiveAlive(build.archive)) continue;
      console.warn(`${build.fullVersion} ${build.architecture}: archive copy ${build.archive} does not answer; dropping it`);
      delete build.archive; delete build.archivedFrom;
    }
    // Archiving may be switched on after builds were recorded: backfill what is still obtainable.
    if (tag) {
      for (const build of next.builds.filter(b => !b.archive && b.platform === 'windows')) {
        const { watched, candidates } = archiveCandidates(build, heads, probe);
        for (const candidate of candidates) {
          try {
            const file = await capture(watched, { ...candidate, expectVersion: build.fullVersion }, directory);
            if (file.sha256 !== build.sha256) { console.warn(`${watched.id}: ${candidate.url} hashes to ${file.sha256}, not the recorded ${build.sha256}; not archived`); continue; }
            ensureRelease(tag, repository);
            build.archive = archive(file, tag, repository);
            build.archivedFrom = new URL(candidate.url).host;
            console.log(`${watched.id}: ${build.fullVersion} archived from ${build.archivedFrom} at ${build.archive}`);
            break;
          } catch (error) { console.warn(`${watched.id}: ${candidate.url}: ${error.message}`); }
        }
      }
    }
    const differs = !previous || canonical(previous) !== canonical(next);
    if (differs) await writeFile(target, serialize(next));
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `changed=${differs}\n`, { flag: 'a' });
    const conflicts = next.builds.filter(b => b.conflict);
    console.log(differs ? `official.json updated: ${captures.length} new build(s), ${next.builds.length} recorded.` : 'No new Spotify build.');
    for (const build of conflicts) console.warn(`CONFLICT ${build.fullVersion} ${build.architecture}: ${build.conflict}`);
    if (failures.length) console.warn(`Some URLs did not answer: ${failures.join('; ')}`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
