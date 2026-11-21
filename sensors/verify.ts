/**
 * Capture-and-verify runs over the builds a detection found, and the merge of the hosts' reports.
 *
 *   node sensors/verify.ts run --detections detections.json --out report.json [--only windows,store]
 *        [--work <dir>] [--keep] [--run-url <url>]
 *   node sensors/verify.ts merge --out merged.json [--summary summary.md] [--alerts alerts.json]
 *        [--sensors windows,macos,apt,snap,store] report-linux.json report-macos.json ...
 *
 * `run` writes its report even when checks fail (the merge decides) and exits 1 only when it could
 * not run. `merge` exits 1 when any artifact is not ok, which marks the CI run as failed.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadTrust } from '../lib/trust.ts';
import type { Detection } from './types.ts';
import { runPipeline, VERIFIABLE_SENSORS } from './verify/pipeline.ts';
import { mergeReports, summaryMarkdown, verificationAlerts, type HostReport } from './verify/report.ts';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    detections: { type: 'string' },
    only: { type: 'string' },
    work: { type: 'string' },
    out: { type: 'string' },
    keep: { type: 'boolean' },
    'run-url': { type: 'string' },
    summary: { type: 'string' },
    alerts: { type: 'string' },
    sensors: { type: 'string' },
  },
});
const [command, ...inputs] = positionals;
const list = (value: string | undefined, fallback: readonly string[]) => value ? value.split(',').map(item => item.trim()).filter(Boolean) : [...fallback];
const now = new Date();

if (command === 'run') {
  if (!values.detections || !values.out) throw new Error('run needs --detections and --out');
  const only = new Set(list(values.only, VERIFIABLE_SENSORS));
  const unknown = [...only].filter(sensor => !(VERIFIABLE_SENSORS as readonly string[]).includes(sensor));
  if (unknown.length) throw new Error(`Not verifiable: ${unknown.join(', ')}`);
  const file = JSON.parse(await readFile(values.detections, 'utf8')) as { results: { sensor: string; ok: boolean; detections?: Detection[] }[] };
  const detections = file.results.flatMap(result => result.detections ?? []);
  for (const result of file.results) if (!result.ok && only.has(result.sensor)) console.error(`${result.sensor}: its detection failed; nothing to verify for it`);
  const report = await runPipeline(detections, {
    fetch, trust: await loadTrust(), now, only,
    workDirectory: values.work ?? join(tmpdir(), 'svh-verify'),
    keepFiles: values.keep ?? false,
    runUrl: values['run-url'] ?? null,
    log: message => console.log(message),
  });
  await writeFile(values.out, JSON.stringify(report, null, 2) + '\n');
  for (const artifact of report.artifacts) {
    const count = (status: string) => artifact.checks.filter(check => check.status === status).length;
    console.log(`${artifact.key}: ${artifact.error ? `ERROR ${artifact.error}` : `${count('pass')} pass, ${count('fail')} fail, ${count('skip')} skip`}${artifact.rotated ? ' (rotated upstream)' : ''}`);
    for (const check of artifact.checks.filter(check => check.status === 'fail')) console.log(`  FAIL ${check.id}: ${check.detail}`);
  }
} else if (command === 'merge') {
  if (!values.out || inputs.length === 0) throw new Error('merge needs --out and at least one report');
  const reports = await Promise.all(inputs.map(async path => JSON.parse(await readFile(path, 'utf8')) as HostReport));
  const merged = mergeReports(reports, now);
  await writeFile(values.out, JSON.stringify(merged, null, 2) + '\n');
  if (values.summary) await writeFile(values.summary, summaryMarkdown(merged), { flag: 'a' });
  if (values.alerts) await writeFile(values.alerts, JSON.stringify(verificationAlerts(merged, list(values.sensors, VERIFIABLE_SENSORS)), null, 2) + '\n');
  const notOk = merged.artifacts.filter(artifact => !artifact.ok);
  console.log(`${merged.artifacts.length} artifact(s), ${notOk.length} not ok`);
  for (const artifact of notOk) console.log(`  ${artifact.key}: ${artifact.problems.join('; ')}`);
  process.exitCode = notOk.length ? 1 : 0;
} else {
  throw new Error(`Unknown command "${command ?? ''}"; use "run" or "merge"`);
}
