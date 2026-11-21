import { describe, expect, it } from 'vitest';
import { LABEL, syncAlerts, type Alert } from '../sensors/alerts.ts';
import type { Fetch } from '../sensors/types.ts';

/** An in-memory GitHub issues API for one repository. */
function fakeGitHub() {
  const issues: { number: number; title: string; body: string; state: string; labels: string[]; comments: string[]; pull_request?: object }[] = [];
  const writes: string[] = [];
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const payload = init.body ? JSON.parse(String(init.body)) : null;
    const path = url.pathname.replace('/repos/o/r', '');
    if (method !== 'GET') writes.push(`${method} ${path}`);
    if (method === 'GET' && path === '/issues') {
      return Response.json(issues.filter(issue => issue.state === 'open' && issue.labels.includes(url.searchParams.get('labels')!)));
    }
    if (method === 'POST' && path === '/issues') {
      const issue = { number: issues.length + 1, title: payload.title, body: payload.body, state: 'open', labels: payload.labels, comments: [] };
      issues.push(issue);
      return Response.json(issue, { status: 201 });
    }
    const match = /^\/issues\/(\d+)(\/comments)?$/.exec(path);
    const issue = match && issues.find(candidate => candidate.number === Number(match[1]));
    if (!issue) return new Response('not found', { status: 404 });
    if (match[2]) { issue.comments.push(payload.body); return Response.json({}, { status: 201 }); }
    Object.assign(issue, payload);
    return Response.json(issue);
  };
  return { fetch: fetchImpl as Fetch, issues, writes };
}

const options = (_github: Fetch, alerts: Alert[], runUrl = 'https://ci/run/1') => ({ repository: 'o/r', token: 't', apiUrl: 'https://api.test', runUrl, alerts });
const failing: Alert = { key: 'verify:windows', title: 'Verification of the current windows builds', ok: false, summary: '1 of 3 windows artifact(s) not ok', details: '- chain' };

describe('alert issues', () => {
  it('opens one issue for a failing key and leaves it alone while the summary stays the same', async () => {
    const github = fakeGitHub();
    expect(await syncAlerts(github.fetch, options(github.fetch, [failing]))).toEqual([{ key: 'verify:windows', action: 'opened', issue: 1 }]);
    expect(github.issues[0]).toMatchObject({ title: failing.title, labels: [LABEL], state: 'open' });
    expect(github.issues[0]!.body).toContain('<!-- sensor-alert:verify:windows -->');
    expect(await syncAlerts(github.fetch, options(github.fetch, [failing], 'https://ci/run/2'))).toEqual([{ key: 'verify:windows', action: 'unchanged', issue: 1 }]);
    expect(github.issues).toHaveLength(1);
  });

  it('comments when the summary changes, and closes the issue when the key passes', async () => {
    const github = fakeGitHub();
    await syncAlerts(github.fetch, options(github.fetch, [failing]));
    const changed = { ...failing, summary: '2 of 3 windows artifact(s) not ok' };
    expect((await syncAlerts(github.fetch, options(github.fetch, [changed])))[0]?.action).toBe('commented');
    expect((await syncAlerts(github.fetch, options(github.fetch, [changed])))[0]?.action).toBe('unchanged');
    expect((await syncAlerts(github.fetch, options(github.fetch, [{ ...failing, ok: true, summary: '3 windows artifact(s) ok' }], 'https://ci/run/9'))))
      .toEqual([{ key: 'verify:windows', action: 'closed', issue: 1 }]);
    expect(github.issues[0]).toMatchObject({ state: 'closed' });
    expect(github.issues[0]!.comments.at(-1)).toContain('https://ci/run/9');
  });

  it('keeps keys apart, ignores pull requests and writes nothing in a dry run', async () => {
    const github = fakeGitHub();
    github.issues.push({ number: 7, title: 'a pull request', body: '<!-- sensor-alert:verify:snap -->', state: 'open', labels: [LABEL], comments: [], pull_request: {} });
    const results = await syncAlerts(github.fetch, { ...options(github.fetch, [failing, { ...failing, key: 'verify:snap', title: 'snap' }]), dryRun: true });
    expect(results.map(result => result.action)).toEqual(['opened', 'opened']);
    expect(github.writes).toEqual([]);
  });
});
