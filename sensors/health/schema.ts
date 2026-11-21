/**
 * The link-health file (written by sensors/health.ts): the last answer of every download link the
 * ledger records, keyed by URL, and how many links of each provider are in each status.
 *
 * Health is data, not a verdict on a build: a mirror being down says nothing about the file's
 * identity, which the captures' checks establish.
 */
import { z } from 'zod';

/**
 * Who serves a link:
 *  - spotify-signed: upgrade.scdn.co with a `fauth` token, valid until the token's `exp`;
 *  - spotify-current: download.scdn.co, which serves whatever build is current;
 *  - spotify-apt: repository.spotify.com;
 *  - snap: api.snapcraft.io downloads of a snap revision;
 *  - loadspot: the LoadSpot community mirror;
 *  - github-archive: a GitHub release download (this repository's archive copies);
 *  - other: anything else, such as upgrade.scdn.co paths without a token.
 */
export const PROVIDERS = ['spotify-signed', 'spotify-current', 'spotify-apt', 'snap', 'loadspot', 'github-archive', 'other'] as const;

/**
 * - ok: 200 (or 206 to a one-byte range) with the recorded size and ETag;
 * - gone: 404 or 410; forbidden: 401 or 403;
 * - expired: a signed link past its token's `exp`, decided without a request;
 * - error: 5xx, another unexpected answer, a network failure, a timeout or a refused redirect;
 * - drift: an answer whose size differs from the ledger's size or whose ETag differs from the newest
 *   capture's ETag (for a current-build URL: a build the ledger has not captured yet);
 * - not-checked: not checked by any run yet (LoadSpot, GitHub and other links are checked weekly).
 */
export const STATUSES = ['ok', 'gone', 'forbidden', 'expired', 'error', 'drift', 'not-checked'] as const;

export type Provider = (typeof PROVIDERS)[number];
export type Status = (typeof STATUSES)[number];

const instant = z.iso.datetime();

export const HealthEntry = z.strictObject({
  provider: z.enum(PROVIDERS),
  status: z.enum(STATUSES),
  /** The status code of the last answer, after redirects; null when no request was made or none answered. */
  httpStatus: z.int().min(100).max(599).nullable(),
  /** The size the server stated (Content-Length, or the total of a Content-Range). */
  size: z.int().nonnegative().nullable(),
  etag: z.string().nullable(),
  lastModified: instant.nullable(),
  /**
   * The URL the last answer came from. After a redirect its query and fragment are dropped: GitHub
   * and the Snap Store redirect to signed addresses whose parameters change with every request.
   */
  finalUrl: z.url().nullable(),
  /** When the run that set this entry looked at the link; null while it was never looked at. */
  checkedAt: instant.nullable(),
  /** How long the requests took; null when none was made. */
  ms: z.int().nonnegative().nullable(),
  /** One line: what was expected and what was found, or why no request was made. */
  detail: z.string(),
  /** For a signed link: the `exp` of its token. */
  expiresAt: instant.optional(),
});

export const Summary = z.record(z.enum(PROVIDERS), z.record(z.enum(STATUSES), z.int().nonnegative()));

export const HealthFile = z.strictObject({
  schema: z.literal(1),
  generatedAt: instant,
  sources: z.record(z.url(), HealthEntry),
  summary: Summary,
}).superRefine((file, ctx) => {
  const expected = summarize(file.sources);
  for (const provider of PROVIDERS) {
    for (const status of STATUSES) {
      if (file.summary[provider]?.[status] !== expected[provider][status]) {
        ctx.addIssue({ code: 'custom', path: ['summary', provider, status], message: `the sources count ${expected[provider][status]}` });
      }
    }
  }
});

export type HealthEntry = z.infer<typeof HealthEntry>;
export type Summary = z.infer<typeof Summary>;
export type HealthFile = z.infer<typeof HealthFile>;

/** Entries per provider and status, every pair present (zero when no entry has it). */
export function summarize(sources: Readonly<Record<string, Pick<HealthEntry, 'provider' | 'status'>>>): Summary {
  const summary = Object.fromEntries(PROVIDERS.map(provider => [provider, Object.fromEntries(STATUSES.map(status => [status, 0]))])) as Summary;
  for (const entry of Object.values(sources)) summary[entry.provider][entry.status] += 1;
  return summary;
}
