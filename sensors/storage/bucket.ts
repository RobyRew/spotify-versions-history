/**
 * The R2 bucket's settings that can make R2 bill outside the archive's own requests, read through
 * Cloudflare's API (api.cloudflare.com/client/v4, with a token that has Workers R2 Storage: Read):
 *
 *  - the public r2.dev URL and custom domains: reads through them skip the files Worker, and the
 *    Worker is what bounds Class B operations (Workers Free stops at 100,000 requests a day, and the
 *    Worker makes at most two R2 reads per request);
 *  - the bucket's default storage class, and lifecycle rules that move objects to another class:
 *    Infrequent Access has no free tier;
 *  - Sippy, which copies objects into the bucket from another provider by itself: Class A writes and
 *    storage that the archive's budget and cap do not see.
 *
 * settingsProblems() names each problem; a setting it cannot read counts as a problem too.
 */

type Fetch = typeof fetch;

/** One setting as read: the `result` of Cloudflare's response, or why it could not be read. */
export type SettingRead = { result: unknown } | { error: string };

export interface BucketSettings {
  bucket: SettingRead;
  managed: SettingRead;
  custom: SettingRead;
  lifecycle: SettingRead;
  sippy: SettingRead;
}

/** Each setting's path under /accounts/{account}/r2/buckets/{bucket}. */
export const SETTING_PATHS: Readonly<Record<keyof BucketSettings, string>> = {
  bucket: '',
  managed: '/domains/managed',
  custom: '/domains/custom',
  lifecycle: '/lifecycle',
  sippy: '/sippy',
};

export async function readBucketSettings(accountId: string, bucket: string, token: string, fetchImpl: Fetch = fetch): Promise<BucketSettings> {
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}`;
  const read = async (path: string): Promise<SettingRead> => {
    try {
      const response = await fetchImpl(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
      const body = await response.json().catch(() => null) as { success?: unknown; result?: unknown; errors?: unknown } | null;
      if (response.ok && body?.success === true && body.result !== undefined) return { result: body.result };
      const errors = Array.isArray(body?.errors) ? body.errors.map(error => `${(error as { code?: unknown }).code}: ${(error as { message?: unknown }).message}`).join('; ') : '';
      // The API answers an invalid token with 400 (code 9106) and a token without the permission with 403.
      const hint = [400, 401, 403].includes(response.status) ? ' (CLOUDFLARE_API_TOKEN must be valid and have Workers R2 Storage: Read on the account)' : '';
      return { error: `HTTP ${response.status}${errors ? ` ${errors}` : ''}${hint}` };
    } catch (error) {
      return { error: (error as Error).message };
    }
  };
  const [bucketInfo, managed, custom, lifecycle, sippy] = await Promise.all([
    read(SETTING_PATHS.bucket), read(SETTING_PATHS.managed), read(SETTING_PATHS.custom), read(SETTING_PATHS.lifecycle), read(SETTING_PATHS.sippy),
  ]);
  return { bucket: bucketInfo!, managed: managed!, custom: custom!, lifecycle: lifecycle!, sippy: sippy! };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const shown = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, 200);
const SKIPS_WORKER = "reads through it skip the files Worker and its daily request cap";
const NO_FREE_TIER = 'Infrequent Access has no free tier';

/** Every setting that could make R2 bill, in words; empty when there is none. */
export function settingsProblems(settings: BucketSettings): string[] {
  const problems: string[] = [];
  const check = (read: SettingRead, what: string, inspect: (result: unknown) => void): void => {
    if ('error' in read) problems.push(`cannot read ${what}: ${read.error}`);
    else inspect(read.result);
  };

  check(settings.managed, 'the r2.dev URL setting', result => {
    if (!isObject(result) || typeof result.enabled !== 'boolean') problems.push(`cannot read the r2.dev URL setting from ${shown(result)}`);
    else if (result.enabled) problems.push(`the public r2.dev URL is enabled: ${SKIPS_WORKER}`);
  });

  check(settings.custom, 'the custom domains', result => {
    if (!isObject(result) || !Array.isArray(result.domains)) problems.push(`cannot read the custom domains from ${shown(result)}`);
    else for (const domain of result.domains) {
      problems.push(isObject(domain)
        ? `custom domain ${String(domain.domain)} is connected (enabled: ${String(domain.enabled)}): ${SKIPS_WORKER}`
        : `a custom domain is connected (${shown(domain)}): ${SKIPS_WORKER}`);
    }
  });

  check(settings.bucket, "the bucket's properties", result => {
    if (!isObject(result) || typeof result.storage_class !== 'string') problems.push(`cannot read the bucket's default storage class from ${shown(result)}`);
    else if (result.storage_class !== 'Standard') problems.push(`the bucket's default storage class is ${result.storage_class}, not Standard: ${NO_FREE_TIER}`);
  });

  check(settings.lifecycle, 'the lifecycle rules', result => {
    if (!isObject(result) || !Array.isArray(result.rules)) {
      problems.push(`cannot read the lifecycle rules from ${shown(result)}`);
      return;
    }
    for (const rule of result.rules) {
      if (!isObject(rule)) {
        problems.push(`cannot read a lifecycle rule from ${shown(rule)}`);
        continue;
      }
      // A disabled rule counts too: switching it on would start the moves.
      const transitions = rule.storageClassTransitions;
      if (transitions === undefined || (Array.isArray(transitions) && transitions.length === 0)) continue;
      const classes = Array.isArray(transitions) ? transitions.map(transition => (isObject(transition) ? String(transition.storageClass) : shown(transition))).join(', ') : shown(transitions);
      problems.push(`lifecycle rule "${String(rule.id)}" (enabled: ${String(rule.enabled)}) moves objects to ${classes}: ${NO_FREE_TIER}`);
    }
  });

  check(settings.sippy, 'the Sippy setting', result => {
    if (!isObject(result) || typeof result.enabled !== 'boolean') problems.push(`cannot read the Sippy setting from ${shown(result)}`);
    else if (result.enabled) problems.push("Sippy is on: it copies objects into the bucket from another provider, outside the archive's budget and cap");
  });

  return problems;
}
