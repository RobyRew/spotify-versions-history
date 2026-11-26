/**
 * The archive's own copies in Cloudflare R2, through R2's S3-compatible API with AWS Signature V4
 * (region "auto"). HEAD, PUT and ListObjectsV2: a copy is written once under its SHA-256 and never
 * changed, and the bucket is listed to measure what it holds.
 *
 * R2 bills past its free tier, so the client carries the limits itself (web/README.md, "Free-tier
 * limits", gives the reason for each). Every request goes through `send`, which, before anything
 * leaves the process, charges the request to the run's operation budget (refusing it once that
 * class is spent) and refuses any x-amz-storage-class other than STANDARD. `put` also refuses to
 * write until `measure` has listed the bucket in this run, and refuses a body that would take the
 * bucket past the cap.
 *
 *   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (repository secrets)
 *   R2_BUCKET                                                        (default spotify-versions-archive)
 */
import { createHash, createHmac } from 'node:crypto';
import { FREE_TIER_CAP_BYTES } from './archive.ts';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Default https://<accountId>.r2.cloudflarestorage.com (tests point it elsewhere). */
  endpoint?: string;
}

type Fetch = typeof fetch;

/** R2's free operations per month (Standard storage only; Infrequent Access has no free tier). */
export const FREE_TIER_OPERATIONS = { A: 1_000_000, B: 10_000_000 } as const;

/**
 * The most requests of each class one run sends. verify.yml runs once a day, so its scheduled runs
 * send at most 31 × 200 = 6,200 of each class a month.
 */
export const RUN_BUDGET = { A: 200, B: 200 } as const;

/** The only storage class this client sends. STANDARD_IA (Infrequent Access) has no free tier. */
export const STORAGE_CLASS = 'STANDARD';

/** ListObjectsV2 pages measure() reads (1,000 keys each) before it gives up without a total. */
export const MAX_LIST_PAGES = 10;

export type OperationClass = 'A' | 'B';

/**
 * The class R2 bills a request as. HEAD (HeadObject) is Class B. This client sends GET only to list
 * (ListObjectsV2, Class A), so every request other than HEAD is counted as Class A: that can count
 * a request as dearer than it is, never as cheaper.
 */
export const operationClass = (method: string): OperationClass => (method.toUpperCase() === 'HEAD' ? 'B' : 'A');

export class BudgetSpent extends Error {
  override name = 'BudgetSpent';
}

/** Counts a run's requests per class and refuses the next one once a class reaches its limit. */
export function operationBudget(limits: Readonly<Record<OperationClass, number>> = RUN_BUDGET) {
  const used: Record<OperationClass, number> = { A: 0, B: 0 };
  return {
    limits: { ...limits },
    used: (): Record<OperationClass, number> => ({ ...used }),
    /** Counts one request of `kind`, or throws BudgetSpent without counting it. */
    charge(kind: OperationClass, what: string): void {
      if (used[kind] >= limits[kind]) throw new BudgetSpent(`R2 Class ${kind} budget for this run (${limits[kind]} requests) is spent; ${what} was not sent`);
      used[kind] += 1;
    },
  };
}

export type OperationBudget = ReturnType<typeof operationBudget>;

/** Throws when `headers` carry an x-amz-storage-class other than STANDARD. */
export function assertStandardOnly(headers: Readonly<Record<string, string>>): void {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'x-amz-storage-class' && value !== STORAGE_CLASS) {
      throw new Error(`refusing to send x-amz-storage-class: ${value}; the archive writes only ${STORAGE_CLASS} (Infrequent Access has no free tier)`);
    }
  }
}

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
// RFC 3986: unreserved characters stay, everything else is percent-encoded (encodeURIComponent leaves !'()*).
const rfc3986 = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
// '/' is kept between path segments.
const encodePath = (path: string): string => path.split('/').map(rfc3986).join('/');

export interface SignInput {
  method: string;
  url: URL;
  headers: Record<string, string>;
  payloadSha256: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** `YYYYMMDDTHHMMSSZ` */
  amzDate: string;
}

/** The Authorization header of an AWS Signature V4 request; `headers` must include host, x-amz-date and x-amz-content-sha256. */
export function signV4(input: SignInput): string {
  const names = Object.keys(input.headers).map(name => name.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')]));
  // Parameters sorted by encoded name, then by encoded value.
  const query = [...input.url.searchParams]
    .map(([key, value]) => [rfc3986(key), rfc3986(value)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const canonical = [
    input.method,
    encodePath(decodeURIComponent(input.url.pathname)),
    query,
    names.map(name => `${name}:${lower[name]}\n`).join(''),
    names.join(';'),
    input.payloadSha256,
  ].join('\n');
  const day = input.amzDate.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', input.amzDate, scope, sha256Hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${input.secretAccessKey}`, day), input.region), input.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
}

export interface ListedObject {
  key: string;
  size: number;
  /** Null when the response names none. */
  storageClass: string | null;
}

export interface ListPage {
  objects: ListedObject[];
  truncated: boolean;
  /** The continuation token for the next page, when `truncated`. */
  next: string | null;
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const xmlText = (value: string): string => value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (match, entity: string) =>
  entity.startsWith('#x') ? String.fromCodePoint(parseInt(entity.slice(2), 16))
  : entity.startsWith('#') ? String.fromCodePoint(Number(entity.slice(1)))
  : ENTITIES[entity] ?? match);
const element = (xml: string, name: string): string | null => {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return match ? xmlText(match[1]!) : null;
};

/**
 * One ListObjectsV2 response page. Throws on anything it cannot read (no ListBucketResult, an
 * object without a key or a whole-number size, KeyCount differing from the objects read, a
 * truncated page without a continuation token), so a total summed from pages is whole or absent.
 */
export function parseListPage(xml: string): ListPage {
  if (!/<ListBucketResult[\s>]/.test(xml)) throw new Error(`not a ListObjectsV2 response: ${xml.slice(0, 200)}`);
  const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map(([, block]) => {
    const key = element(block!, 'Key');
    const size = element(block!, 'Size')?.trim() ?? '';
    if (key === null || !/^\d+$/.test(size) || !Number.isSafeInteger(Number(size))) throw new Error(`an object without a readable key or size: ${block!.slice(0, 200)}`);
    return { key, size: Number(size), storageClass: element(block!, 'StorageClass')?.trim() ?? null };
  });
  const truncated = element(xml, 'IsTruncated')?.trim();
  if (truncated !== 'true' && truncated !== 'false') throw new Error('the response has no IsTruncated');
  const keyCount = element(xml, 'KeyCount')?.trim();
  if (keyCount !== undefined && Number(keyCount) !== objects.length) throw new Error(`KeyCount is ${keyCount}, but ${objects.length} objects were read`);
  const next = element(xml, 'NextContinuationToken');
  if (truncated === 'true' && !next) throw new Error('a truncated page without a NextContinuationToken');
  return { objects, truncated: truncated === 'true', next: truncated === 'true' ? next : null };
}

export const DEFAULT_BUCKET = 'spotify-versions-archive';

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket: env.R2_BUCKET || DEFAULT_BUCKET };
}

export interface R2ClientOptions {
  /** The most bytes the bucket may hold after a PUT; values above FREE_TIER_CAP_BYTES are lowered to it. */
  capBytes: number;
  /** Bytes the caller has on record as stored (the archive record); PUTs count the larger of this and the listing. */
  knownBytes?: number;
  /** Default: a new budget of RUN_BUDGET. */
  budget?: OperationBudget;
  fetch?: Fetch;
  clock?: () => Date;
}

export function r2Client(config: R2Config, options: R2ClientOptions) {
  const endpoint = config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
  const fetchImpl = options.fetch ?? fetch;
  const clock = options.clock ?? (() => new Date());
  const budget = options.budget ?? operationBudget();
  const capBytes = Math.min(options.capBytes, FREE_TIER_CAP_BYTES);
  const knownBytes = options.knownBytes ?? 0;
  const EMPTY = sha256Hex('');
  /** Bytes counted as stored: null until measure() lists the bucket, then max(listing, knownBytes). */
  let counted: number | null = null;
  /** Bytes of the PUTs sent in this run, counted before each is sent. */
  let written = 0;

  const objectUrl = (key: string) => new URL(`${endpoint}/${config.bucket}/${encodePath(key)}`);
  // The query is percent-encoded the way signV4 encodes it, so the URL sent is the URL signed.
  const bucketUrl = (params: readonly (readonly [string, string])[]) => new URL(`${endpoint}/${config.bucket}?${params.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join('&')}`);

  /** Every request to R2 passes here: storage class checked, budget charged, then signed and sent. */
  const send = (method: string, url: URL, payloadSha256: string, extra: Record<string, string> = {}, body?: Uint8Array): Promise<Response> => {
    assertStandardOnly(extra);
    budget.charge(operationClass(method), `${method} ${url.pathname}`);
    const amzDate = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadSha256, ...extra };
    const authorization = signV4({ method, url, headers, payloadSha256, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: 'auto', service: 's3', amzDate });
    const { host: _host, ...sent } = headers;
    return fetchImpl(url, body ? { method, headers: { ...sent, authorization }, body } : { method, headers: { ...sent, authorization } });
  };

  return {
    capBytes,
    budget,
    /** Bytes counted as stored (null before measure()), bytes written in this run, and the requests sent per class. */
    usage: () => ({ counted, written, requests: budget.used() }),

    /**
     * Lists every object (ListObjectsV2, 1,000 keys a page, at most MAX_LIST_PAGES pages; each page
     * is one Class A request) and sums their sizes. Throws when a page cannot be read or an object is
     * in a class other than STANDARD; until it returns, put() refuses to write.
     */
    async measure(): Promise<{ objects: number; bytes: number }> {
      counted = null;
      let objects = 0;
      let bytes = 0;
      let token: string | null = null;
      const otherClass: string[] = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const params: [string, string][] = [['list-type', '2'], ['max-keys', '1000']];
        if (token !== null) params.push(['continuation-token', token]);
        const response = await send('GET', bucketUrl(params), EMPTY);
        const text = await response.text();
        if (!response.ok) throw new Error(`R2 ListObjectsV2: HTTP ${response.status} ${text.slice(0, 300)}`);
        const listed = parseListPage(text);
        for (const object of listed.objects) {
          objects += 1;
          bytes += object.size;
          if (object.storageClass !== null && object.storageClass !== STORAGE_CLASS) otherClass.push(`${object.key} (${object.storageClass})`);
        }
        if (!listed.truncated) {
          if (otherClass.length > 0) throw new Error(`${otherClass.length} object(s) not in ${STORAGE_CLASS}, the only class with a free tier: ${otherClass.slice(0, 5).join(', ')}`);
          counted = Math.max(bytes, knownBytes);
          return { objects, bytes };
        }
        token = listed.next;
      }
      throw new Error(`R2 ListObjectsV2: more than ${MAX_LIST_PAGES} pages of 1,000 objects; the bucket was not measured`);
    },

    /** The object's size, or null when it does not exist. */
    async head(key: string): Promise<{ size: number } | null> {
      const response = await send('HEAD', objectUrl(key), EMPTY);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`R2 HEAD ${key}: HTTP ${response.status}`);
      return { size: Number(response.headers.get('content-length') ?? 0) };
    },

    /**
     * Writes the object as STANDARD; R2 refuses it when the body's SHA-256 is not `sha256`. Refused
     * before measure() has returned, and when the bytes counted as stored, plus those written in
     * this run, plus the body would pass the cap. The body counts as written once it is sent,
     * whatever R2 answers.
     */
    async put(key: string, body: Uint8Array, options: { sha256: string; contentType: string; contentDisposition: string }): Promise<void> {
      if (counted === null) throw new Error(`R2 PUT ${key}: the bucket was not measured in this run, so nothing is written`);
      if (counted + written + body.byteLength > capBytes) throw new Error(`R2 PUT ${key}: ${body.byteLength} bytes on top of the ${counted + written} counted would pass the ${capBytes}-byte cap`);
      written += body.byteLength;
      const response = await send('PUT', objectUrl(key), options.sha256, {
        'content-type': options.contentType,
        'content-disposition': options.contentDisposition,
        'content-length': String(body.byteLength),
        'x-amz-checksum-sha256': Buffer.from(options.sha256, 'hex').toString('base64'),
        'x-amz-storage-class': STORAGE_CLASS,
      }, body);
      if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    },
  };
}

export type R2Client = ReturnType<typeof r2Client>;
