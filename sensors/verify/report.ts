/**
 * Verification reports: what each host (Linux, macOS, Windows) checked on each captured file, merged
 * into one verdict per artifact.
 *
 * A host report lists the artifacts it captured with every Check row it produced. The merge joins
 * the hosts' rows per artifact, requires that every host hashed the same bytes (equal SHA-256), and
 * derives the verification level from the check families that passed. A single "fail" row anywhere,
 * a capture error, or two hosts disagreeing on the bytes makes the artifact not ok.
 */
import type { Arch, Format, Platform, Product } from '../types.ts';
import type { Check, VerificationLevel } from './types.ts';

export interface FileDigests {
  md5: string;
  sha1: string;
  sha256: string;
  sha512: string;
  sha3_384: string;
}

export interface ArtifactReport {
  /** `<fullVersion or version>-<platform>-<arch>-<format>`, the ledger's artifact id shape. */
  key: string;
  sensor: string;
  product: Product;
  version: string;
  fullVersion: string | null;
  platform: Platform;
  arch: Arch;
  format: Format;
  /** Where the bytes came from; Microsoft Store links are short-lived and kept without their query string. */
  source: { url: string; finalUrl: string | null; etag: string | null; lastModified: string | null } | null;
  file: ({ size: number } & FileDigests) | null;
  checks: Check[];
  /** Set when the file could not be captured or checked at all. */
  error?: string;
  /** Set when the upstream file changed between detection and capture (HTTP 412 on If-Match). */
  rotated?: boolean;
}

export interface HostReport {
  schema: 1;
  /** process.platform of the host that ran the checks. */
  host: string;
  /** OS release and tool versions, for the reader of the report. */
  hostDetail: string;
  generatedAt: string;
  /** URL of the CI run, when there is one. */
  run: string | null;
  artifacts: ArtifactReport[];
}

export interface MergedArtifact {
  key: string;
  sensor: string;
  version: string;
  fullVersion: string | null;
  platform: Platform;
  arch: Arch;
  format: Format;
  hosts: string[];
  size: number | null;
  sha256: string | null;
  level: VerificationLevel;
  ok: boolean;
  /** Failure reasons: fail rows, capture errors and digest disagreements between hosts. */
  problems: string[];
  rotated: boolean;
  checks: (Check & { host: string })[];
}

export interface MergedReport {
  schema: 1;
  generatedAt: string;
  runs: string[];
  artifacts: MergedArtifact[];
}

/**
 * Check families that together prove a platform signature with a pinned identity. Every listed id
 * must have passed (on any host) and none of the family's rows may have failed.
 */
const SIGNATURE_FAMILIES: readonly { formats: readonly Format[]; required: readonly string[] }[] = [
  { formats: ['exe'], required: ['authenticode.image-digest', 'authenticode.signature', 'authenticode.signer', 'authenticode.chain'] },
  { formats: ['appx', 'msix', 'appxbundle', 'msixbundle'], required: ['appx.manifest-identity', 'appx.block-map', 'appx.content-digests', 'appx.signature', 'appx.signer', 'appx.chain'] },
  { formats: ['dmg'], required: ['macos.codesign-verify', 'macos.signer', 'macos.gatekeeper'] },
  { formats: ['deb'], required: ['apt.inrelease-signature', 'apt.packages-digest', 'digest.sha256', 'apt.deb-control'] },
  { formats: ['snap'], required: ['snap.assertion-chain', 'snap.revision-digest', 'snap.identity', 'digest.sha3_384'] },
];

/** Sensors whose claimed digest comes from a distribution store's own index. */
const STORE_DIGEST_SENSORS = new Set(['store', 'apt', 'snap']);

export function verificationLevel(format: Format, sensor: string, checks: readonly Check[]): VerificationLevel {
  const passed = new Set(checks.filter(check => check.status === 'pass').map(check => check.id));
  const family = SIGNATURE_FAMILIES.find(candidate => candidate.formats.includes(format));
  if (family && family.required.every(id => passed.has(id))) return 'signed';
  if (passed.has('digest.spotify-binary-hash')) return 'spotify-digest';
  if (STORE_DIGEST_SENSORS.has(sensor) && [...passed].some(id => id === 'digest.sha256' || id === 'digest.sha3_384')) return 'store-digest';
  return 'unverified';
}

export function mergeReports(reports: readonly HostReport[], now: Date): MergedReport {
  const byKey = new Map<string, { report: ArtifactReport; host: string }[]>();
  for (const report of reports) {
    for (const artifact of report.artifacts) {
      const entries = byKey.get(artifact.key) ?? [];
      entries.push({ report: artifact, host: report.host });
      byKey.set(artifact.key, entries);
    }
  }
  const artifacts: MergedArtifact[] = [];
  for (const [key, entries] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    const first = entries[0]!.report;
    const problems: string[] = [];
    const checks = entries.flatMap(({ report, host }) => report.checks.map(check => ({ ...check, host })));
    for (const { report, host } of entries) {
      if (report.error) problems.push(`${host}: ${report.error}`);
    }
    for (const check of checks) {
      if (check.status === 'fail') problems.push(`${check.host} ${check.id}: ${check.detail}`);
    }
    const hashes = new Map<string, string[]>();
    for (const { report, host } of entries) {
      if (!report.file) continue;
      hashes.set(report.file.sha256, [...(hashes.get(report.file.sha256) ?? []), host]);
    }
    if (hashes.size > 1) {
      problems.push(`hosts captured different bytes: ${[...hashes].map(([hash, hosts]) => `${hosts.join('+')} ${hash}`).join('; ')}`);
    }
    const rotated = entries.some(({ report }) => report.rotated === true);
    const file = entries.find(({ report }) => report.file)?.report.file ?? null;
    if (!file && !rotated && problems.length === 0) problems.push('no host captured the file');
    // A rotation is not a verification failure: the build changed upstream and the next run captures the new one.
    const ok = problems.length === 0 && file !== null;
    artifacts.push({
      key, sensor: first.sensor, version: first.version, fullVersion: first.fullVersion,
      platform: first.platform, arch: first.arch, format: first.format,
      hosts: [...new Set(entries.map(entry => entry.host))],
      size: file?.size ?? null, sha256: file?.sha256 ?? null,
      level: ok ? verificationLevel(first.format, first.sensor, checks) : 'unverified',
      ok: ok || (rotated && problems.length === 0), problems, rotated, checks,
    });
  }
  return { schema: 1, generatedAt: now.toISOString(), runs: [...new Set(reports.map(report => report.run).filter((run): run is string => run !== null))], artifacts };
}

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');

/** Markdown for the CI run's step summary. */
export function summaryMarkdown(merged: MergedReport): string {
  const lines = [
    '## Verification of the current builds',
    '',
    '| Artifact | Level | Size | SHA-256 | Checks (pass / fail / skip) | Hosts |',
    '| --- | --- | ---: | --- | --- | --- |',
  ];
  for (const artifact of merged.artifacts) {
    const count = (status: Check['status']) => artifact.checks.filter(check => check.status === status).length;
    const state = artifact.rotated && artifact.problems.length === 0 ? 'rotated upstream' : artifact.ok ? artifact.level : `**not ok** (${artifact.level})`;
    lines.push(`| ${cell(artifact.key)} | ${state} | ${artifact.size ?? '—'} | ${artifact.sha256 ? `\`${artifact.sha256.slice(0, 16)}…\`` : '—'} | ${count('pass')} / ${count('fail')} / ${count('skip')} | ${artifact.hosts.join(', ')} |`);
  }
  const problems = merged.artifacts.filter(artifact => artifact.problems.length);
  if (problems.length) {
    lines.push('', '### Problems', '');
    for (const artifact of problems) {
      lines.push(`- **${cell(artifact.key)}**`);
      for (const problem of artifact.problems) lines.push(`  - ${cell(problem)}`);
    }
  }
  return lines.join('\n') + '\n';
}

export interface Alert {
  key: string;
  title: string;
  ok: boolean;
  summary: string;
  details?: string;
}

/** One alert per sensor: failing while any of its artifacts is not ok. */
export function verificationAlerts(merged: MergedReport, sensors: readonly string[]): Alert[] {
  return sensors.map(sensor => {
    const artifacts = merged.artifacts.filter(artifact => artifact.sensor === sensor);
    const failing = artifacts.filter(artifact => !artifact.ok);
    const missing = artifacts.length === 0;
    const ok = !missing && failing.length === 0;
    const summary = missing
      ? `No ${sensor} artifact was captured`
      : failing.length
        ? `${failing.length} of ${artifacts.length} ${sensor} artifact(s) not ok: ${failing.map(artifact => artifact.key).join(', ')}`
        : `${artifacts.length} ${sensor} artifact(s) ok`;
    const details = failing.flatMap(artifact => [`${artifact.key}:`, ...artifact.problems.map(problem => `- ${problem}`)]).join('\n');
    return { key: `verify:${sensor}`, title: `Verification of the current ${sensor} builds`, ok, summary, ...(details ? { details } : {}) };
  });
}
