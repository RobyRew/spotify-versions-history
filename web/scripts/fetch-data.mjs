// Downloads the newest link-health file and verification report from the repository's CI runs into
// .data/, for running the site locally: node scripts/fetch-data.mjs [--out <dir>]
// It uses the GitHub CLI (gh), which must be signed in (in Actions: GH_TOKEN with actions: read);
// artifacts of public repositories still need a token. The Pages build runs it with --out to publish
// both files next to the static APIs, where the production site reads them.
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = process.env.GITHUB_REPOSITORY ?? 'RobyRew/spotify-versions-history';
const wanted = [
  { workflow: 'health.yml', artifact: 'health', file: 'health.json', target: 'health.json' },
  { workflow: 'verify.yml', artifact: 'merged-report', file: 'merged.json', target: 'verification.json' },
];

const outIndex = process.argv.indexOf('--out');
const out = outIndex > 0 ? process.argv[outIndex + 1] : '.data';
if (!out) throw new Error('--out needs a directory');
await mkdir(out, { recursive: true });
for (const { workflow, artifact, file, target } of wanted) {
  const { stdout } = await run('gh', ['run', 'list', '--repo', repository, '--workflow', workflow, '--status', 'completed', '--limit', '10', '--json', 'databaseId,conclusion']);
  const runs = JSON.parse(stdout);
  let saved = false;
  for (const { databaseId } of runs) {
    const directory = await mkdtemp(join(tmpdir(), 'svh-data-'));
    try {
      await run('gh', ['run', 'download', String(databaseId), '--repo', repository, '--name', artifact, '--dir', directory]);
      if ((await readdir(directory)).includes(file)) {
        await copyFile(join(directory, file), join(out, target));
        console.log(`${join(out, target)} from run ${databaseId}`);
        saved = true;
        break;
      }
    } catch {
      // That run has no such artifact (failed before uploading it); try the one before.
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  if (!saved) console.error(`no ${artifact} artifact in the last ${runs.length} ${workflow} runs`);
}
