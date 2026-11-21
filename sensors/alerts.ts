/**
 * One GitHub issue per failing check, labelled sensor-alert:
 *  - a failing key without an open issue opens one;
 *  - a failing key with an open issue gets a comment only when its summary changed (the issue body
 *    keeps the SHA-256 of the last summary in a hidden marker);
 *  - a passing key with an open issue gets a comment naming the run and is closed.
 * Issues are found by the hidden marker <!-- sensor-alert:<key> --> in their body.
 *
 *   node sensors/alerts.ts --alerts alerts.json [--dry-run]
 * reads GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL and GITHUB_RUN_ID.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { USER_AGENT } from './lib/http.ts';
import type { Fetch } from './types.ts';

export const LABEL = 'sensor-alert';

export const Alert = z.object({ key: z.string().min(1), title: z.string().min(1), ok: z.boolean(), summary: z.string(), details: z.string().optional() });
export type Alert = z.infer<typeof Alert>;
export type AlertAction = 'opened' | 'commented' | 'closed' | 'unchanged';

interface Issue { number: number; body: string | null; pull_request?: unknown }

const marker = (key: string) => `<!-- ${LABEL}:${key} -->`;
const summaryMarker = (summary: string) => `<!-- ${LABEL}-summary:${createHash('sha256').update(summary).digest('hex')} -->`;
const SUMMARY_MARKER = new RegExp(`<!-- ${LABEL}-summary:[0-9a-f]{64} -->`);

function body(alert: Alert, runUrl: string): string {
  return [
    marker(alert.key),
    summaryMarker(alert.summary),
    `**${alert.summary}**`,
    '',
    alert.details ? `${alert.details}\n` : '',
    `Last seen failing in ${runUrl}. This issue closes itself when the check passes again.`,
  ].join('\n');
}

export async function syncAlerts(fetchImpl: Fetch, options: { repository: string; token: string; apiUrl?: string; runUrl: string; alerts: readonly Alert[]; dryRun?: boolean }): Promise<{ key: string; action: AlertAction; issue: number | null }[]> {
  const api = `${options.apiUrl ?? 'https://api.github.com'}/repos/${options.repository}`;
  const call = async (method: string, path: string, payload?: unknown): Promise<unknown> => {
    const response = await fetchImpl(`${api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${options.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
        'user-agent': USER_AGENT, ...(payload ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
    return response.status === 204 ? null : response.json();
  };
  const open: Issue[] = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await call('GET', `/issues?state=open&labels=${LABEL}&per_page=100&page=${page}`) as Issue[];
    open.push(...batch.filter(issue => !issue.pull_request));
    if (batch.length < 100) break;
  }
  const results: { key: string; action: AlertAction; issue: number | null }[] = [];
  for (const alert of options.alerts) {
    const issue = open.find(candidate => (candidate.body ?? '').includes(marker(alert.key))) ?? null;
    if (alert.ok) {
      if (!issue) { results.push({ key: alert.key, action: 'unchanged', issue: null }); continue; }
      if (!options.dryRun) {
        await call('POST', `/issues/${issue.number}/comments`, { body: `Passing again in ${options.runUrl}: ${alert.summary}` });
        await call('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });
      }
      results.push({ key: alert.key, action: 'closed', issue: issue.number });
    } else if (!issue) {
      let number: number | null = null;
      if (!options.dryRun) number = (await call('POST', '/issues', { title: alert.title, body: body(alert, options.runUrl), labels: [LABEL] }) as { number: number }).number;
      results.push({ key: alert.key, action: 'opened', issue: number });
    } else if ((issue.body ?? '').includes(summaryMarker(alert.summary))) {
      results.push({ key: alert.key, action: 'unchanged', issue: issue.number });
    } else {
      if (!options.dryRun) {
        await call('POST', `/issues/${issue.number}/comments`, { body: `${alert.summary}\n\n${alert.details ?? ''}\n\nSeen in ${options.runUrl}.` });
        await call('PATCH', `/issues/${issue.number}`, { body: (issue.body ?? '').replace(SUMMARY_MARKER, summaryMarker(alert.summary)) });
      }
      results.push({ key: alert.key, action: 'commented', issue: issue.number });
    }
  }
  return results;
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { alerts: { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  if (!values.alerts) throw new Error('--alerts is required');
  const alerts = z.array(Alert).parse(JSON.parse(await readFile(values.alerts, 'utf8')));
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL, GITHUB_SERVER_URL, GITHUB_RUN_ID } = process.env;
  const dryRun = values['dry-run'] ?? false;
  if (!GITHUB_REPOSITORY || (!GITHUB_TOKEN && !dryRun)) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  const runUrl = `${GITHUB_SERVER_URL ?? 'https://github.com'}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID ?? ''}`;
  const results = await syncAlerts(fetch, { repository: GITHUB_REPOSITORY, token: GITHUB_TOKEN ?? '', runUrl, alerts, dryRun, ...(GITHUB_API_URL ? { apiUrl: GITHUB_API_URL } : {}) });
  for (const result of results) console.log(`${result.key}: ${result.action}${result.issue ? ` #${result.issue}` : ''}`);
}
