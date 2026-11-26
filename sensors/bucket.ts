/**
 * Exits 1 when the R2 bucket's settings could make R2 bill outside the archive's own limits: a
 * public r2.dev URL, a custom domain, a default storage class other than Standard, a lifecycle rule
 * that moves objects to another class, Sippy, or a setting it cannot read (sensors/storage/bucket.ts):
 *
 *   node sensors/bucket.ts
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers R2 Storage: Read); R2_BUCKET names
 * another bucket. worker.yml runs it every day.
 */
import { readBucketSettings, settingsProblems } from './storage/bucket.ts';
import { DEFAULT_BUCKET } from './storage/r2.ts';

const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token } = process.env;
const bucket = process.env.R2_BUCKET || DEFAULT_BUCKET;
if (!accountId || !token) {
  console.error("::error::CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are needed to read the bucket's settings; nothing was checked.");
  process.exit(1);
}

const problems = settingsProblems(await readBucketSettings(accountId, bucket, token));
if (problems.length === 0) {
  console.log(`${bucket}: no public r2.dev URL, no custom domain, default storage class Standard, no lifecycle rule moving objects to another class, Sippy off.`);
} else {
  for (const problem of problems) console.error(`::error::${bucket}: ${problem}`);
  process.exitCode = 1;
}
