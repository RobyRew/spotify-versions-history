import { describe, expect, it } from 'vitest';
import { checkSource, classify, healthAlerts, runHealth, tokenExpiry, weeklySlot, type SourceRef } from '../../sensors/health/check.ts';
import type { HealthFile } from '../../sensors/health/schema.ts';
import type { Fetch } from '../../sensors/types.ts';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const jwt = (payload: object) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.c2ln`;

type Route = { status: number; headers?: Record<string, string> };
function fakeFetch(routes: Record<string, Route | ((method: string, headers: Record<string, string>) => Route)>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push(`${method} ${url}`);
    const route = routes[url];
    const answer = typeof route === 'function' ? route(method, (init.headers ?? {}) as Record<string, string>) : route;
    if (!answer) throw new TypeError('fetch failed');
    return new Response(null, { status: answer.status, headers: answer.headers ?? {} });
  };
  return { fetch: fetchImpl as Fetch, calls };
}

const ref = (url: string, overrides: Partial<SourceRef> = {}): SourceRef => ({ url, provider: classify(url), expectedSize: null, expectedEtag: null, ...overrides });

describe('link health', () => {
  it('classifies the ledger\'s hosts', () => {
    expect(classify('https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.3.4.gabc-5.exe?fauth=x')).toBe('spotify-signed');
    expect(classify('https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.3.4.gabc-5.exe')).toBe('other');
    expect(classify('https://download.scdn.co/SpotifyFullSetupX64.exe')).toBe('spotify-current');
    expect(classify('https://loadspot.amd64fox1.workers.dev/download/x.exe')).toBe('loadspot');
    expect(classify('https://github.com/RobyRew/spotify-versions-history/releases/download/t/x.exe')).toBe('github-archive');
  });

  it('decides an expired signed link from its token without a request', async () => {
    const url = `https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.3.4.gabc-5.exe?fauth=${jwt({ exp: Date.parse('2026-10-01T00:00:00Z') / 1000 })}`;
    expect(tokenExpiry(url)?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    const { fetch, calls } = fakeFetch({});
    expect(await checkSource(fetch, ref(url), NOW)).toMatchObject({ status: 'expired', expiresAt: '2026-10-01T00:00:00.000Z' });
    expect(calls).toEqual([]);
  });

  it('reports ok, drift, gone, forbidden and errors', async () => {
    const { fetch } = fakeFetch({
      'https://download.scdn.co/a.exe': { status: 200, headers: { 'content-length': '100', etag: '"e1"' } },
      'https://download.scdn.co/b.exe': { status: 200, headers: { 'content-length': '100', etag: '"e2"' } },
      'https://repository.spotify.com/gone.deb': { status: 404 },
      'https://upgrade.scdn.co/forbidden.exe': { status: 403 },
      'https://loadspot.amd64fox1.workers.dev/download/x.exe': { status: 502 },
    });
    expect((await checkSource(fetch, ref('https://download.scdn.co/a.exe', { expectedSize: 100, expectedEtag: '"e1"' }), NOW)).status).toBe('ok');
    expect(await checkSource(fetch, ref('https://download.scdn.co/b.exe', { expectedEtag: '"e1"' }), NOW)).toMatchObject({ status: 'drift', detail: expect.stringMatching(/ETag "e2"/) });
    expect((await checkSource(fetch, ref('https://download.scdn.co/a.exe', { expectedSize: 99 }), NOW)).status).toBe('drift');
    expect((await checkSource(fetch, ref('https://repository.spotify.com/gone.deb'), NOW)).status).toBe('gone');
    expect((await checkSource(fetch, ref('https://upgrade.scdn.co/forbidden.exe'), NOW)).status).toBe('forbidden');
    expect((await checkSource(fetch, ref('https://loadspot.amd64fox1.workers.dev/download/x.exe'), NOW)).status).toBe('error');
    expect((await checkSource(fetch, ref('https://download.scdn.co/unreachable.exe'), NOW)).status).toBe('error');
  });

  it('follows redirects by hand, keeps the target without its query and refuses plain http', async () => {
    const { fetch } = fakeFetch({
      'https://github.com/o/r/releases/download/t/x.exe': { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset/1?sig=abc' } },
      'https://release-assets.githubusercontent.com/asset/1?sig=abc': { status: 200, headers: { 'content-length': '5' } },
      'https://github.com/o/r/releases/download/t/y.exe': { status: 302, headers: { location: 'http://insecure.example/y.exe' } },
    });
    expect(await checkSource(fetch, ref('https://github.com/o/r/releases/download/t/x.exe'), NOW)).toMatchObject({ status: 'ok', finalUrl: 'https://release-assets.githubusercontent.com/asset/1', size: 5 });
    expect(await checkSource(fetch, ref('https://github.com/o/r/releases/download/t/y.exe'), NOW)).toMatchObject({ status: 'error', detail: expect.stringMatching(/http: refused/) });
  });

  it('asks for one byte where HEAD is refused', async () => {
    const { fetch } = fakeFetch({
      'https://loadspot.amd64fox1.workers.dev/download/z.exe': (method, headers) => method === 'HEAD'
        ? { status: 405 }
        : headers.range === 'bytes=0-0' ? { status: 206, headers: { 'content-range': 'bytes 0-0/1234' } } : { status: 400 },
    });
    expect(await checkSource(fetch, ref('https://loadspot.amd64fox1.workers.dev/download/z.exe', { expectedSize: 1234 }), NOW)).toMatchObject({ status: 'ok', size: 1234 });
  });

  it('checks mirror links in their weekly slot and carries other results over', async () => {
    const mirror = Array.from({ length: 21 }, (_, index) => `https://loadspot.amd64fox1.workers.dev/download/build-${index}.exe`);
    const today = mirror.filter(url => weeklySlot(url, NOW));
    expect(today.length).toBeGreaterThan(0);
    expect(today.length).toBeLessThan(mirror.length);
    const routes = Object.fromEntries([...mirror, 'https://download.scdn.co/SpotifyFullSetupX64.exe'].map(url => [url, { status: 200, headers: { 'content-length': '1' } }]));
    const { fetch, calls } = fakeFetch(routes);
    const refs = new Map([...mirror, 'https://download.scdn.co/SpotifyFullSetupX64.exe'].map(url => [url, ref(url)]));
    const kept = mirror.find(url => !weeklySlot(url, NOW))!;
    const previous = { sources: { [kept]: { provider: 'loadspot', status: 'gone', httpStatus: 404, size: null, etag: null, lastModified: null, finalUrl: kept, checkedAt: '2026-11-15T00:00:00.000Z', ms: 10, detail: 'HTTP 404' } } } as unknown as HealthFile;
    const { file, checked } = await runHealth(fetch, refs, { now: NOW, previous, pauseMs: 0 });
    expect(checked).toBe(today.length + 1);
    expect(calls.filter(call => call.includes('loadspot'))).toHaveLength(today.length);
    expect(file.sources[kept]).toMatchObject({ status: 'gone', checkedAt: '2026-11-15T00:00:00.000Z' });
    expect(file.sources[mirror.find(url => !weeklySlot(url, NOW) && url !== kept)!]?.status).toBe('not-checked');
    expect(file.summary['spotify-current'].ok).toBe(1);
    // A second run on the same day checks only the every-run providers again.
    const again = fakeFetch(routes);
    const second = await runHealth(again.fetch, refs, { now: new Date('2026-11-20T18:00:00.000Z'), previous: file, pauseMs: 0 });
    expect(second.checked).toBe(1);
    expect(again.calls).toEqual(['HEAD https://download.scdn.co/SpotifyFullSetupX64.exe']);
  });

  it('raises an alert for a current-build URL that does not answer and for a failing mirror', () => {
    const entry = (provider: string, status: string, checkedAt = NOW.toISOString()) => ({ provider, status, httpStatus: null, size: null, etag: null, lastModified: null, finalUrl: null, checkedAt, ms: 1, detail: status });
    const sources: Record<string, unknown> = { 'https://download.scdn.co/a.exe': entry('spotify-current', 'error') };
    for (let index = 0; index < 12; index++) sources[`https://loadspot.amd64fox1.workers.dev/download/${index}.exe`] = entry('loadspot', index < 8 ? 'error' : 'ok');
    const alerts = healthAlerts({ sources } as unknown as HealthFile, NOW);
    expect(alerts.map(alert => [alert.key, alert.ok])).toEqual([['health:spotify-current', false], ['health:loadspot', false]]);
  });
});
