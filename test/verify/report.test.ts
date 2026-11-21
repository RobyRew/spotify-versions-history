import { describe, expect, it } from 'vitest';
import { mergeReports, summaryMarkdown, verificationAlerts, verificationLevel, type ArtifactReport, type HostReport } from '../../sensors/verify/report.ts';
import { fail, pass, skip, type Check } from '../../sensors/verify/types.ts';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const digests = (sha256: string) => ({ size: 100, md5: 'a'.repeat(32), sha1: 'b'.repeat(40), sha256, sha512: 'c'.repeat(128), sha3_384: 'd'.repeat(96) });

function artifact(overrides: Partial<ArtifactReport> = {}): ArtifactReport {
  return {
    key: '1.3.10.2586.g81a118a22460-windows-x64-exe', sensor: 'windows', product: 'desktop',
    version: '1.3.10.2586', fullVersion: '1.3.10.2586.g81a118a22460', platform: 'windows', arch: 'x64', format: 'exe',
    source: { url: 'https://download.scdn.co/SpotifyFullSetupX64.exe', finalUrl: null, etag: null, lastModified: null },
    file: digests('1'.repeat(64)), checks: [], ...overrides,
  };
}

const host = (name: string, artifacts: ArtifactReport[]): HostReport =>
  ({ schema: 1, host: name, hostDetail: name, generatedAt: NOW.toISOString(), run: `https://ci/${name}`, artifacts });

const AUTHENTICODE: Check[] = ['authenticode.image-digest', 'authenticode.signature', 'authenticode.signer', 'authenticode.chain'].map(id => pass(id, 'svh-authenticode/1', 'ok'));

describe('verification level', () => {
  it('is signed only when every check of the platform family passed', () => {
    expect(verificationLevel('exe', 'windows', AUTHENTICODE)).toBe('signed');
    expect(verificationLevel('exe', 'windows', AUTHENTICODE.slice(1))).toBe('unverified');
  });

  it('falls back to a store digest for store channels, never for the CDN', () => {
    const digest = [pass('digest.sha256', 'svh-capture/1', 'equal')];
    expect(verificationLevel('deb', 'apt', digest)).toBe('store-digest');
    expect(verificationLevel('dmg', 'macos', [pass('digest.md5', 'svh-capture/1', 'equal')])).toBe('unverified');
  });
});

describe('merging host reports', () => {
  it('joins the checks of every host and keeps the signed level', () => {
    const merged = mergeReports([
      host('linux', [artifact({ checks: AUTHENTICODE })]),
      host('win32', [artifact({ checks: [pass('windows.authenticode-status', 'Get-AuthenticodeSignature', 'Valid')] })]),
    ], NOW);
    expect(merged.artifacts).toHaveLength(1);
    expect(merged.artifacts[0]).toMatchObject({ ok: true, level: 'signed', hosts: ['linux', 'win32'] });
    expect(merged.artifacts[0]!.checks).toHaveLength(5);
  });

  it('fails an artifact that two hosts captured with different bytes', () => {
    const merged = mergeReports([
      host('linux', [artifact({ checks: AUTHENTICODE })]),
      host('win32', [artifact({ file: digests('2'.repeat(64)) })]),
    ], NOW);
    expect(merged.artifacts[0]!.ok).toBe(false);
    expect(merged.artifacts[0]!.level).toBe('unverified');
    expect(merged.artifacts[0]!.problems.join()).toMatch(/different bytes/);
  });

  it('fails on any fail row, even when the signature family passed elsewhere', () => {
    const merged = mergeReports([
      host('linux', [artifact({ checks: AUTHENTICODE })]),
      host('win32', [artifact({ checks: [fail('windows.signtool', 'signtool', 'exit 1')] })]),
    ], NOW);
    expect(merged.artifacts[0]).toMatchObject({ ok: false, level: 'unverified' });
  });

  it('treats an upstream rotation as not a failure, and a missing capture as one', () => {
    const rotated = mergeReports([host('linux', [artifact({ file: null, rotated: true, checks: [skip('capture.if-match', 'svh-verify/1', '412')] })])], NOW);
    expect(rotated.artifacts[0]).toMatchObject({ ok: true, rotated: true, level: 'unverified' });
    const missing = mergeReports([host('linux', [artifact({ file: null })])], NOW);
    expect(missing.artifacts[0]).toMatchObject({ ok: false, problems: ['no host captured the file'] });
  });

  it('reports a capture error as a problem', () => {
    const merged = mergeReports([host('linux', [artifact({ file: null, error: 'sha256 mismatch' })])], NOW);
    expect(merged.artifacts[0]!.problems).toEqual(['linux: sha256 mismatch']);
  });
});

describe('alerts and summary', () => {
  it('raise one alert per sensor with the failing artifacts, and one for a sensor with nothing captured', () => {
    const merged = mergeReports([host('linux', [artifact({ checks: [fail('authenticode.chain', 'svh-authenticode/1', 'no pinned root')] })])], NOW);
    const alerts = verificationAlerts(merged, ['windows', 'snap']);
    expect(alerts.map(alert => [alert.key, alert.ok])).toEqual([['verify:windows', false], ['verify:snap', false]]);
    expect(alerts[0]!.details).toMatch(/no pinned root/);
    expect(alerts[1]!.summary).toBe('No snap artifact was captured');
  });

  it('pass a sensor whose artifacts are all ok', () => {
    const merged = mergeReports([host('linux', [artifact({ checks: AUTHENTICODE })])], NOW);
    expect(verificationAlerts(merged, ['windows'])[0]).toMatchObject({ ok: true, summary: '1 windows artifact(s) ok' });
  });

  it('render a table row per artifact and list the problems', () => {
    const merged = mergeReports([host('linux', [artifact({ checks: [fail('authenticode.chain', 'svh-authenticode/1', 'no | pinned root')] })])], NOW);
    const markdown = summaryMarkdown(merged);
    expect(markdown).toMatch(/\| 1\.3\.10\.2586\.g81a118a22460-windows-x64-exe \| \*\*not ok\*\*/);
    expect(markdown).toMatch(/no \\\| pinned root/);
  });
});
