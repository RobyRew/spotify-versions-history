/**
 * Runs the channel sensors: node sensors/run.ts detect [--only windows,snap] [--state ledger/sensors]
 * [--write] [--json detections.json]
 *
 * Each sensor's reading is kept in <state>/<id>.json and rewritten (with --write) only when it changed,
 * so a run that sees nothing new leaves the tree untouched. A failing sensor does not stop the others;
 * the exit code is 1 when any failed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadTrust } from '../lib/trust.ts';
import { compareVersions } from '../lib/versions.ts';
import { SENSORS } from './registry.ts';
import type { Detection } from './types.ts';

interface StateFile {
  schema: 1;
  sensor: string;
  /** When the reading last changed. */
  observedAt: string;
  reading: Record<string, unknown>;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { only: { type: 'string' }, state: { type: 'string' }, write: { type: 'boolean' }, json: { type: 'string' } },
});
const command = positionals[0] ?? 'detect';
if (command !== 'detect') throw new Error(`Unknown command "${command}"; the sensors support "detect"`);
const only = values.only ? new Set(values.only.split(',').map(id => id.trim())) : null;
const unknown = [...(only ?? [])].filter(id => !SENSORS.some(sensor => sensor.id === id));
if (unknown.length) throw new Error(`Unknown sensor(s): ${unknown.join(', ')}`);
const stateDirectory = values.state ?? 'ledger/sensors';
const trust = await loadTrust();
const now = new Date();

async function readState(path: string): Promise<StateFile | null> {
  try { return JSON.parse(await readFile(path, 'utf8')) as StateFile; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Every build when there are a few; counts per platform and the newest version for a whole catalog. */
function summarize(detections: Detection[]): string {
  const label = (d: Detection) => `${d.platform}/${d.arch}/${d.format}`;
  if (detections.length <= 8) {
    return `${detections.length} build(s)${detections.length ? `: ${detections.map(d => `${label(d)} ${d.fullVersion ?? d.version}`).join(', ')}` : ''}`;
  }
  const counts = new Map<string, number>();
  for (const detection of detections) counts.set(label(detection), (counts.get(label(detection)) ?? 0) + 1);
  const newest = detections.reduce((best, d) => compareVersions(d.version, best.version) > 0 ? d : best);
  return `${detections.length} builds (${[...counts].map(([kind, count]) => `${kind} ${count}`).join(', ')}); newest ${newest.fullVersion ?? newest.version}`;
}

const results: { sensor: string; ok: boolean; detections?: Detection[]; notes?: string[]; error?: string }[] = [];
for (const sensor of SENSORS) {
  if (only && !only.has(sensor.id)) continue;
  const path = join(stateDirectory, `${sensor.id}.json`);
  const previous = await readState(path);
  try {
    const result = await sensor.detect({ fetch, now, previous: previous?.reading ?? null, trust, log: message => console.error(message) });
    results.push({ sensor: sensor.id, ok: true, detections: result.detections, notes: result.notes });
    console.log(`${sensor.id}: ${summarize(result.detections)}`);
    for (const note of result.notes) console.log(`  note: ${note}`);
    const changed = JSON.stringify(previous?.reading) !== JSON.stringify(result.state);
    if (values.write && changed) {
      const file: StateFile = { schema: 1, sensor: sensor.id, observedAt: now.toISOString(), reading: result.state };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(file, null, 2) + '\n');
      console.log(`  reading changed; wrote ${path}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ sensor: sensor.id, ok: false, error: message });
    console.error(`${sensor.id}: FAILED ${message}`);
  }
}
if (values.json) {
  await writeFile(values.json, JSON.stringify({ checkedAt: now.toISOString(), results }, null, 2) + '\n');
}
process.exitCode = results.some(result => !result.ok) ? 1 : 0;
