import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readBucketSettings, SETTING_PATHS, settingsProblems, type BucketSettings } from '../../sensors/storage/bucket.ts';

// The bucket's real settings as Cloudflare's API returned them on 2026-11-26 (ids replaced).
const REAL = JSON.parse(readFileSync(new URL('../../testdata/r2/bucket-settings.json', import.meta.url), 'utf8')) as Record<keyof BucketSettings, unknown>;
const settings = (overrides: Partial<Record<keyof BucketSettings, unknown>> = {}): BucketSettings => {
  const results = { ...REAL, ...overrides };
  return { bucket: { result: results.bucket }, managed: { result: results.managed }, custom: { result: results.custom }, lifecycle: { result: results.lifecycle }, sippy: { result: results.sippy } };
};
const IA_RULE = { id: 'Move to IA after 30 days', enabled: true, conditions: { prefix: '' }, storageClassTransitions: [{ condition: { type: 'Age', maxAge: 2_592_000 }, storageClass: 'InfrequentAccess' }] };
const CUSTOM_DOMAIN = { domain: 'files.example.com', enabled: true, status: { ownership: 'active', ssl: 'active' }, minTLS: '1.2', zoneId: 'z', zoneName: 'example.com' };

describe('bucket settings', () => {
  it('finds nothing in the real settings: r2.dev off, no custom domain, Standard, only the multipart-abort rule, Sippy off', () => {
    expect(settingsProblems(settings())).toEqual([]);
  });

  it('names a public r2.dev URL and every custom domain, enabled or not', () => {
    expect(settingsProblems(settings({ managed: { ...(REAL.managed as object), enabled: true } }))).toEqual([
      "the public r2.dev URL is enabled: reads through it skip the files Worker and its daily request cap",
    ]);
    expect(settingsProblems(settings({ custom: { domains: [CUSTOM_DOMAIN, { ...CUSTOM_DOMAIN, domain: 'old.example.com', enabled: false }] } }))).toEqual([
      'custom domain files.example.com is connected (enabled: true): reads through it skip the files Worker and its daily request cap',
      'custom domain old.example.com is connected (enabled: false): reads through it skip the files Worker and its daily request cap',
    ]);
  });

  it('names Infrequent Access as the default class, and lifecycle rules moving objects to it, enabled or not', () => {
    expect(settingsProblems(settings({ bucket: { ...(REAL.bucket as object), storage_class: 'InfrequentAccess' } }))).toEqual([
      "the bucket's default storage class is InfrequentAccess, not Standard: Infrequent Access has no free tier",
    ]);
    const rules = [...(REAL.lifecycle as { rules: object[] }).rules, IA_RULE, { ...IA_RULE, id: 'paused', enabled: false }, { id: 'expire', enabled: true, deleteObjectsTransition: { condition: { type: 'Age', maxAge: 86_400 } }, storageClassTransitions: [] }];
    expect(settingsProblems(settings({ lifecycle: { rules } }))).toEqual([
      'lifecycle rule "Move to IA after 30 days" (enabled: true) moves objects to InfrequentAccess: Infrequent Access has no free tier',
      'lifecycle rule "paused" (enabled: false) moves objects to InfrequentAccess: Infrequent Access has no free tier',
    ]);
  });

  it('names Sippy when it is on', () => {
    expect(settingsProblems(settings({ sippy: { enabled: true, source: { provider: 'aws' } } }))).toEqual([
      "Sippy is on: it copies objects into the bucket from another provider, outside the archive's budget and cap",
    ]);
  });

  it('counts a setting it cannot read as a problem', () => {
    const problems = settingsProblems(settings({ managed: {}, custom: { domains: 'none' }, bucket: { name: 'x' }, lifecycle: null, sippy: { enabled: 'no' } }));
    expect(problems).toHaveLength(5);
    expect(problems.every(problem => problem.startsWith('cannot read'))).toBe(true);
    expect(settingsProblems(settings({ lifecycle: { rules: ['x'] } }))).toEqual(['cannot read a lifecycle rule from "x"']);
    expect(settingsProblems({ ...settings(), custom: { error: 'HTTP 403 10000: Authentication error' } })).toEqual(['cannot read the custom domains: HTTP 403 10000: Authentication error']);
  });
});

describe('reading the settings from Cloudflare’s API', () => {
  const TOKEN = 'token-value-not-for-logs';
  const envelope = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], messages: [], result }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('reads each setting’s result with the bearer token', async () => {
    const seen: { url: string; authorization: string }[] = [];
    const byPath: Record<string, unknown> = Object.fromEntries(Object.entries(SETTING_PATHS).map(([name, path]) => [path, REAL[name as keyof BucketSettings]]));
    const fake = (async (url: string, init: RequestInit) => {
      seen.push({ url, authorization: (init.headers as Record<string, string>).authorization! });
      return envelope(byPath[url.replace('https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/spotify-versions-archive', '')]);
    }) as unknown as typeof fetch;
    const read = await readBucketSettings('acct', 'spotify-versions-archive', TOKEN, fake);
    expect(seen.map(call => call.url).sort()).toEqual([
      'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/spotify-versions-archive',
      'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/spotify-versions-archive/domains/custom',
      'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/spotify-versions-archive/domains/managed',
      'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/spotify-versions-archive/lifecycle',
      'https://api.cloudflare.com/client/v4/accounts/acct/r2/buckets/spotify-versions-archive/sippy',
    ]);
    expect(seen.every(call => call.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(read).toEqual(settings());
    expect(settingsProblems(read)).toEqual([]);
  });

  it('turns refusals, errors and unreadable answers into problems that do not show the token', async () => {
    const answers: (() => Response)[] = [
      // What the API answered an invalid token with on 2026-11-26 (HTTP 400, code 9106).
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 9106, message: 'Authentication failed (status: 400)' }], messages: [], result: null }), { status: 400 }),
      () => new Response('<html>bad gateway</html>', { status: 502 }),
      () => new Response(JSON.stringify({ success: false, errors: [{ code: 10006, message: 'The specified bucket does not exist.' }], result: null }), { status: 404 }),
      () => new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 }),
      () => { throw new TypeError('fetch failed'); },
    ];
    let call = 0;
    const fake = (async () => answers[call++]!()) as unknown as typeof fetch;
    const problems = settingsProblems(await readBucketSettings('acct', 'spotify-versions-archive', TOKEN, fake));
    expect(problems).toHaveLength(5);
    expect(problems.every(problem => problem.startsWith('cannot read'))).toBe(true);
    expect(problems.join('\n')).toContain('HTTP 400 9106: Authentication failed (status: 400) (CLOUDFLARE_API_TOKEN must be valid and have Workers R2 Storage: Read on the account)');
    expect(problems.join('\n')).toContain('HTTP 502');
    expect(problems.join('\n')).toContain('fetch failed');
    expect(problems.join('\n')).not.toContain(TOKEN);
  });
});
