/**
 * Spotify's apt repository (repository.spotify.com), suites stable and testing. The Packages index is
 * accepted only when its SHA-256 and size equal the entry in the suite's InRelease; the InRelease
 * OpenPGP signature itself is checked with gpgv against the pinned key before a capture is recorded.
 * The pool keeps about two versions, so every build has to be captured while it is listed.
 */
import { FULL_VERSION, numericVersion } from '../../lib/versions.ts';
import { parseClearsigned, parseControl, parseRelease } from '../lib/deb.ts';
import { sha256Hex } from '../lib/digests.ts';
import { getBytes } from '../lib/http.ts';
import type { Detection, Sensor } from '../types.ts';

export const APT_REPOSITORY = 'https://repository.spotify.com';
export const APT_SUITES = ['stable', 'testing'] as const;
const PACKAGES_PATH = 'non-free/binary-amd64/Packages';

export interface AptSuiteReading {
  date: string | null;
  inReleaseSha256: string;
  packagesSha256: string;
  builds: { debVersion: string; filename: string; size: number; sha256: string }[];
}

export function aptSuite(suite: string, inRelease: Uint8Array, packages: Uint8Array): { reading: AptSuiteReading; detections: Detection[]; notes: string[] } {
  const release = parseRelease(parseClearsigned(Buffer.from(inRelease).toString('utf8')).body);
  const listed = release.sha256.get(PACKAGES_PATH);
  if (!listed) throw new Error(`${suite}: InRelease lists no ${PACKAGES_PATH}`);
  const packagesSha256 = sha256Hex(packages);
  if (listed.hash !== packagesSha256 || listed.size !== packages.length) {
    throw new Error(`${suite}: Packages (${packages.length} bytes, sha256 ${packagesSha256}) is not the one InRelease lists (${listed.size} bytes, ${listed.hash})`);
  }
  const detections: Detection[] = [];
  const notes: string[] = [];
  const builds: AptSuiteReading['builds'] = [];
  for (const paragraph of parseControl(Buffer.from(packages).toString('utf8'))) {
    if (paragraph.Package !== 'spotify-client') continue;
    const debVersion = paragraph.Version ?? '';
    const fullVersion = debVersion.replace(/^\d+:/, '');
    if (!FULL_VERSION.test(fullVersion) || paragraph.Architecture !== 'amd64' || !paragraph.Filename || !paragraph.SHA256) {
      notes.push(`${suite}: skipped spotify-client ${debVersion} (${paragraph.Architecture})`);
      continue;
    }
    const size = Number(paragraph.Size);
    builds.push({ debVersion, filename: paragraph.Filename, size, sha256: paragraph.SHA256 });
    detections.push({
      sensor: 'apt', product: 'desktop',
      version: numericVersion(fullVersion), fullVersion,
      platform: 'linux', arch: 'x64', format: 'deb',
      url: `${APT_REPOSITORY}/${paragraph.Filename}`, lifetime: 'current-build',
      size: Number.isSafeInteger(size) && size > 0 ? size : null,
      claimed: {
        sha256: paragraph.SHA256,
        ...(paragraph.SHA1 ? { sha1: paragraph.SHA1 } : {}),
        ...(paragraph.SHA512 ? { sha512: paragraph.SHA512 } : {}),
        ...(paragraph.MD5sum ? { md5: paragraph.MD5sum } : {}),
      },
      meta: { suite, debVersion, inReleaseSha256: sha256Hex(inRelease) },
    });
  }
  return { reading: { date: release.fields.Date ?? null, inReleaseSha256: sha256Hex(inRelease), packagesSha256, builds }, detections, notes };
}

export const apt: Sensor = {
  id: 'apt',
  describe: "Spotify's apt repository, suites stable and testing",
  async detect({ fetch }) {
    const suites: Record<string, AptSuiteReading> = {};
    const detections: Detection[] = [];
    const notes: string[] = [];
    for (const suite of APT_SUITES) {
      const inRelease = await getBytes(fetch, `${APT_REPOSITORY}/dists/${suite}/InRelease`);
      const packages = await getBytes(fetch, `${APT_REPOSITORY}/dists/${suite}/${PACKAGES_PATH}`);
      const result = aptSuite(suite, inRelease, packages);
      suites[suite] = result.reading;
      detections.push(...result.detections);
      notes.push(...result.notes);
    }
    return { state: { suites }, detections, notes };
  },
};
