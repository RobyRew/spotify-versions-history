// Downloads the newest link-health file and verification report from the repository's CI runs into
// .data/, for running the site locally: node scripts/fetch-data.mjs
// It uses the GitHub CLI (gh), which must be signed in; artifacts of public repositories still need a token.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const repository = process.env.GITHUB_REPOSITORY ?? 'RobyRew/spotify-versions-history';
const wanted = [
  { workflow: 'health.yml', artifact: 'health', file: 'health.json', target: 'health.json' },
  { workflow: 'verify.yml', artifact: 'merged-report', file: 'merged.json', target: 'verification.json' },
];

await mkdir('.data', { recursive: true });
for (const { workflow, artifact, file, target } of wanted) {
  const { stdout } = await run('gh', ['run', 'list', '--repo', repository, '--workflow', workflow, '--status', 'completed', '--limit', '10', '--json', 'databaseId,conclusion']);
  const runs = JSON.parse(stdout);
  let saved = false;
  for (const { databaseId } of runs) {
    const directory = await mkdtemp(join(tmpdir(), 'svh-data-'));
    try {
      await run('gh', ['run', 'download', String(databaseId), '--repo', repository, '--name', artifact, '--dir', directory]);
      if ((await readdir(directory)).includes(file)) {
        await rename(join(directory, file), join('.data', target));
        console.log(`.data/${target} from run ${databaseId}`);
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
