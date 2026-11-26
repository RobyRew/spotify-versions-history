/**
 * The archive's own copies in Cloudflare R2, through R2's S3-compatible API with AWS Signature V4
 * (region "auto"). Only HEAD and PUT: a copy is written once under its SHA-256 and never changed.
 *
 *   CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   (repository secrets)
 *   R2_BUCKET                                                        (default spotify-versions-archive)
 */
import { createHash, createHmac } from 'node:crypto';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Default https://<accountId>.r2.cloudflarestorage.com (tests point it elsewhere). */
  endpoint?: string;
}

type Fetch = typeof fetch;

const sha256Hex = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest();
// RFC 3986 unreserved characters stay; everything else is percent-encoded, '/' kept between segments.
const encodePath = (path: string): string => path.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

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
  const query = [...input.url.searchParams].map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)]).sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)).map(([key, value]) => `${key}=${value}`).join('&');
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

export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  return { accountId, accessKeyId, secretAccessKey, bucket: env.R2_BUCKET || 'spotify-versions-archive' };
}

export function r2Client(config: R2Config, fetchImpl: Fetch = fetch, clock: () => Date = () => new Date()) {
  const endpoint = config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`;
  const objectUrl = (key: string) => new URL(`${endpoint}/${config.bucket}/${encodePath(key)}`);
  const signed = (method: string, url: URL, payloadSha256: string, extra: Record<string, string> = {}): Record<string, string> => {
    const amzDate = clock().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const headers: Record<string, string> = { host: url.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadSha256, ...extra };
    return { ...headers, authorization: signV4({ method, url, headers, payloadSha256, accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, region: 'auto', service: 's3', amzDate }) };
  };
  const EMPTY = sha256Hex('');
  return {
    /** The object's size, or null when it does not exist. */
    async head(key: string): Promise<{ size: number } | null> {
      const url = objectUrl(key);
      const { host: _host, ...headers } = signed('HEAD', url, EMPTY);
      const response = await fetchImpl(url, { method: 'HEAD', headers });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`R2 HEAD ${key}: HTTP ${response.status}`);
      return { size: Number(response.headers.get('content-length') ?? 0) };
    },
    /** Writes the object; R2 refuses it when the body's SHA-256 is not `sha256`. */
    async put(key: string, body: Uint8Array, options: { sha256: string; contentType: string; contentDisposition: string }): Promise<void> {
      const url = objectUrl(key);
      const { host: _host, ...headers } = signed('PUT', url, options.sha256, {
        'content-type': options.contentType,
        'content-disposition': options.contentDisposition,
        'content-length': String(body.byteLength),
        'x-amz-checksum-sha256': Buffer.from(options.sha256, 'hex').toString('base64'),
      });
      const response = await fetchImpl(url, { method: 'PUT', headers, body });
      if (!response.ok) throw new Error(`R2 PUT ${key}: HTTP ${response.status} ${(await response.text()).slice(0, 300)}`);
    },
  };
}

export type R2Client = ReturnType<typeof r2Client>;
