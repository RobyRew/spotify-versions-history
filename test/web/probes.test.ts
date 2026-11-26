import { describe, expect, it } from 'vitest';
import { platformProbes, runLine, worstState, type ProbeInput } from '../../lib/site/probes.ts';
import type { MergedArtifact } from '../../sensors/verify/report.ts';

const now = new Date('2026-11-26T15:00:00Z');
const words = (iso: string) => iso.slice(0, 16);
const artifact = (sensor: string, ok: boolean, version = '1.3.10.2586'): MergedArtifact => ({
  key: `${sensor}-${version}`, sensor, version, fullVersion: null, platform: 'windows', arch: 'x64', format: 'exe', hosts: ['linux'],
  size: 1, sha256: null, level: 'signed', ok, problems: [], rotated: false, checks: [],
} as unknown as MergedArtifact);

function input(overrides: Partial<ProbeInput> = {}): ProbeInput {
  return {
    now,
    releases: [],
    verification: { generatedAt: '2026-11-26T04:28:00Z', artifacts: [artifact('windows', true), artifact('windows', true), artifact('store', true, '1.310.2586.0')] },
    health: { generatedAt: '2026-11-26T12:44:00Z', summary: { 'spotify-current': { ok: 3, gone: 0, 'not-checked': 0 }, loadspot: { ok: 1, gone: 1, 'not-checked': 9 } } },
    watched: { 'windows-x64': { lastModified: '2026-11-18T13:09:13Z' } },
    mobile: { windowsStore: { lastUpdate: '2026-11-25T17:34:40Z' } },
    mobileHistory: {
      schemaVersion: 1, changedAt: '2026-11-26T15:00:00Z',
      ios: { listing: '', versions: [{ version: '9.2.2', releasedAt: '2026-11-20T07:17:17Z', firstSeen: '', minimumOsVersion: '16.1' }, { version: '9.1.46', releasedAt: '2026-05-13T18:43:39Z', firstSeen: '' }] },
      android: { listing: '', updates: [{ updatedAt: '2026-11-24T13:53:28Z', firstSeen: '', reportedVersion: '9.1.82.2155' }] },
    },
    runs: {
      'watch-spotify.yml': { conclusion: 'success', startedAt: '2026-11-26T14:33:00Z', url: 'https://example.test/1' },
      'pages.yml': { conclusion: 'success', startedAt: '2026-11-26T12:44:00Z', url: 'https://example.test/2' },
    },
    ...overrides,
  };
}

describe('platform probes', () => {
  it('builds six cards with their newest version and the worst line as the state', () => {
    const cards = platformProbes(input(), words);
    expect(cards.map(card => card.id)).toEqual(['windows', 'macos', 'linux', 'windows-store', 'ios', 'android']);
    const windows = cards[0]!;
    // Mirror links: 1 of 2 checked answer → warn.
    expect(windows.lines.find(line => line.label === 'Download links')).toMatchObject({ value: 'Spotify and the mirror: 4 of 5 answer', state: 'warn' });
    expect(windows.lines.find(line => line.label === 'Signature check')).toMatchObject({ value: '2 of 2 current files signed; 2026-11-26T04:28', state: 'ok' });
    expect(windows.state).toBe('warn');
    expect(cards[3]).toMatchObject({ name: 'Microsoft Store', newest: { version: '1.310.2586.0' } });
    expect(cards[4]).toMatchObject({ newest: { version: '9.2.2', date: '2026-11-20T07:17:17Z' }, state: 'ok' });
    expect(cards[4]!.lines.map(line => line.value)).toContain('2, back to 9.1.46');
    expect(cards[5]).toMatchObject({ newest: { version: null, date: '2026-11-24T13:53:28Z' } });
    expect(cards[5]!.lines.find(line => line.label === 'Reported by reviewers')?.value).toBe('9.1.82.2155');
  });

  it('marks failing signatures and failed runs as danger, late runs and old reports as warn', () => {
    const failing = platformProbes(input({ verification: { generatedAt: '2026-11-26T04:28:00Z', artifacts: [artifact('windows', false)] } }), words)[0]!;
    expect(failing.lines.find(line => line.label === 'Signature check')).toMatchObject({ state: 'danger', value: expect.stringContaining('1 failing') });
    expect(runLine('Watcher', 'Every 30 minutes', { conclusion: 'failure', startedAt: '2026-11-26T14:30:00Z', url: '' }, 2, now, words).state).toBe('danger');
    expect(runLine('Watcher', 'Every 30 minutes', { conclusion: 'success', startedAt: '2026-11-26T10:00:00Z', url: '' }, 2, now, words)).toMatchObject({ state: 'warn', value: expect.stringContaining('(late)') });
    expect(runLine('Watcher', 'Every 30 minutes', undefined, 2, now, words).state).toBe('unknown');
    const old = platformProbes(input({ verification: { generatedAt: '2026-11-24T04:28:00Z', artifacts: [artifact('windows', true)] } }), words)[0]!;
    expect(old.lines.find(line => line.label === 'Signature check')?.state).toBe('warn');
    expect(worstState(['unknown', 'ok', 'warn'])).toBe('warn');
    expect(worstState(['unknown'])).toBe('unknown');
  });
});
