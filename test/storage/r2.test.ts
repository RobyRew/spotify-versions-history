import { describe, expect, it } from 'vitest';
import { FREE_TIER_CAP_BYTES } from '../../sensors/storage/archive.ts';
import {
  assertStandardOnly, BudgetSpent, FREE_TIER_OPERATIONS, MAX_LIST_PAGES, operationBudget, operationClass, parseListPage,
  r2Client, r2ConfigFromEnv, RUN_BUDGET, signV4, STORAGE_CLASS,
} from '../../sensors/storage/r2.ts';

const CONFIG = { accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b' };
const CLOCK = () => new Date('2026-11-26T12:00:00Z');
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const ABC = new TextEncoder().encode('abc');
const PUT = { sha256: SHA_ABC, contentType: 'application/octet-stream', contentDisposition: 'attachment; filename="file.exe"' };
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

type Listed = { key: string; size: number; storageClass?: string };
const listXml = (objects: Listed[], next?: string) => '<?xml version="1.0" encoding="UTF-8"?>\n'
  + '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>b</Name><Prefix></Prefix>'
  + objects.map(object => `<Contents><Key>${object.key}</Key><LastModified>2026-11-26T21:52:59.333Z</LastModified><ETag>&quot;e1&quot;</ETag><Size>${object.size}</Size><StorageClass>${object.storageClass ?? 'STANDARD'}</StorageClass></Contents>`).join('')
  + `<IsTruncated>${next ? 'true' : 'false'}</IsTruncated>${next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ''}<MaxKeys>1000</MaxKeys><KeyCount>${objects.length}</KeyCount></ListBucketResult>`;

interface Call { url: string; method: string; headers: Record<string, string> }

/** A fake R2: GET answers with the listing pages in order (HTTP 500 once they run out), HEAD with what was PUT, PUT with 200. */
function fakeR2(pages: string[] = [listXml([])]) {
  const calls: Call[] = [];
  const objects = new Map<string, number>();
  let page = 0;
  const fake = (async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ url: String(url), method: init.method!, headers });
    const path = new URL(url).pathname;
    if (init.method === 'GET') {
      const body = pages[page];
      page += 1;
      return body === undefined ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : new Response(body, { status: 200 });
    }
    if (init.method === 'HEAD') {
      const size = objects.get(path);
      return size === undefined ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-length': String(size) } });
    }
    if (init.method === 'PUT') {
      objects.set(path, Number(headers['content-length']));
      return new Response(null, { status: 200 });
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;
  return { fake, calls };
}

describe('AWS Signature V4', () => {
  // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html: the published examples.
  const example = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', amzDate: '20130524T000000Z', payloadSha256: EMPTY_SHA };

  it('matches AWS’s published GET Object example', () => {
    const authorization = signV4({
      ...example,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { host: 'examplebucket.s3.amazonaws.com', range: 'bytes=0-9', 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': '20130524T000000Z' },
    });
    expect(authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });

  it('matches AWS’s published GET Bucket (List Objects) example, which signs a query string', () => {
    const authorization = signV4({
      ...example,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J'),
      headers: { host: 'examplebucket.s3.amazonaws.com', 'x-amz-content-sha256': EMPTY_SHA, 'x-amz-date': '20130524T000000Z' },
    });
    expect(authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
  });
});

describe('R2 client', () => {
  it('reads its config from the environment only when all three secrets are set', () => {
    expect(r2ConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b' })).toBeNull();
    expect(r2ConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' })).toEqual({ accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', bucket: 'spotify-versions-archive' });
  });

  it('sends signed HEAD and PUT requests to the bucket path, with the body’s SHA-256 and the Standard class', async () => {
    const { fake, calls } = fakeR2();
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    await client.measure();
    expect(await client.head('sha256/abc/file.exe')).toBeNull();
    await client.put('sha256/abc/file.exe', ABC, PUT);
    expect(await client.head('sha256/abc/file.exe')).toEqual({ size: 3 });
    const put = calls[2]!;
    expect(put.method).toBe('PUT');
    expect(put.url).toBe('https://acct.r2.cloudflarestorage.com/b/sha256/abc/file.exe');
    expect(put.headers['x-amz-content-sha256']).toBe(SHA_ABC);
    expect(put.headers['x-amz-checksum-sha256']).toBe(Buffer.from(SHA_ABC, 'hex').toString('base64'));
    expect(put.headers['x-amz-storage-class']).toBe('STANDARD');
    expect(put.headers['x-amz-date']).toBe('20261126T120000Z');
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261126\/auto\/s3\/aws4_request, SignedHeaders=content-disposition;content-length;content-type;host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=[0-9a-f]{64}$/);
    expect(client.usage()).toEqual({ counted: 0, written: 3, requests: { A: 2, B: 2 } });
  });
});

describe('measuring the bucket', () => {
  it('lists every page with signed ListObjectsV2 requests, follows the continuation token and sums the sizes', async () => {
    // The token comes back XML-escaped and holds characters that must be percent-encoded in the query.
    const { fake, calls } = fakeR2([
      listXml([{ key: 'sha256/a/one.exe', size: 100 }, { key: 'sha256/b/two&amp;three.dmg', size: 250 }], 'tok&amp;en/+=!'),
      listXml([{ key: 'sha256/c/four.snap', size: 50 }]),
    ]);
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    expect(await client.measure()).toEqual({ objects: 3, bytes: 400 });
    expect(calls.map(call => [call.method, call.url])).toEqual([
      ['GET', 'https://acct.r2.cloudflarestorage.com/b?list-type=2&max-keys=1000'],
      ['GET', 'https://acct.r2.cloudflarestorage.com/b?list-type=2&max-keys=1000&continuation-token=tok%26en%2F%2B%3D%21'],
    ]);
    for (const call of calls) expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261126\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(client.usage().counted).toBe(400);
  });

  it('fails closed: no total and no PUT when a page cannot be read', async () => {
    for (const pages of [
      [],                                                                           // HTTP 500
      ['<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'],            // not a listing
      [listXml([{ key: 'a', size: 1 }], 'next')],                                   // page 2 answers 500
      [listXml([{ key: 'a', size: 1 }]).replace('<Size>1</Size>', '<Size>1x</Size>')],
    ]) {
      const { fake, calls } = fakeR2(pages);
      const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
      await expect(client.measure()).rejects.toThrow();
      await expect(client.put('sha256/abc/file.exe', ABC, PUT)).rejects.toThrow(/not measured/);
      expect(calls.every(call => call.method === 'GET')).toBe(true);
    }
  });

  it(`stops after ${MAX_LIST_PAGES} pages without a total`, async () => {
    const { fake, calls } = fakeR2(Array.from({ length: MAX_LIST_PAGES + 5 }, (_, index) => listXml([{ key: `k${index}`, size: 1 }], `t${index}`)));
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    await expect(client.measure()).rejects.toThrow(/not measured/);
    expect(calls).toHaveLength(MAX_LIST_PAGES);
  });

  it('refuses a bucket holding an object outside the Standard class', async () => {
    const { fake } = fakeR2([listXml([{ key: 'sha256/a/one.exe', size: 1 }, { key: 'sha256/b/two.exe', size: 1, storageClass: 'STANDARD_IA' }])]);
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    await expect(client.measure()).rejects.toThrow('sha256/b/two.exe (STANDARD_IA)');
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/not measured/);
  });

  it('closes the gate again when a later measurement fails', async () => {
    const { fake } = fakeR2([listXml([])]);
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    await client.measure();
    await expect(client.measure()).rejects.toThrow(/HTTP 500/);
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/not measured/);
  });

  it('reads a page: keys unescaped, sizes, storage class; anything it cannot read throws', () => {
    expect(parseListPage(listXml([{ key: 'a&amp;b', size: 7 }]))).toEqual({ objects: [{ key: 'a&b', size: 7, storageClass: 'STANDARD' }], truncated: false, next: null });
    expect(parseListPage(listXml([{ key: 'a', size: 7 }]).replace(/<KeyCount>\d+<\/KeyCount>/, '').replace(/<StorageClass>\w+<\/StorageClass>/, '')).objects).toEqual([{ key: 'a', size: 7, storageClass: null }]);
    expect(parseListPage(listXml([], 'abc'))).toEqual({ objects: [], truncated: true, next: 'abc' });
    expect(() => parseListPage('<Error><Code>AccessDenied</Code></Error>')).toThrow(/not a ListObjectsV2/);
    expect(() => parseListPage(listXml([{ key: 'a', size: 7 }]).replace('<Size>7</Size>', ''))).toThrow(/size/);
    expect(() => parseListPage(listXml([{ key: 'a', size: 7 }]).replace('<Size>7</Size>', '<Size>-7</Size>'))).toThrow(/size/);
    expect(() => parseListPage(listXml([{ key: 'a', size: 7 }]).replace('<KeyCount>1</KeyCount>', '<KeyCount>2</KeyCount>'))).toThrow(/KeyCount/);
    expect(() => parseListPage(listXml([]).replace(/<IsTruncated>\w+<\/IsTruncated>/, ''))).toThrow(/IsTruncated/);
    expect(() => parseListPage(listXml([]).replace('<IsTruncated>false</IsTruncated>', '<IsTruncated>true</IsTruncated>'))).toThrow(/NextContinuationToken/);
  });
});

describe('the storage cap on PUT', () => {
  it('refuses to write before the bucket is measured', async () => {
    const { fake, calls } = fakeR2();
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/not measured/);
    expect(calls).toHaveLength(0);
  });

  it('counts the listing and every PUT sent, and refuses the one that would pass the cap', async () => {
    const { fake, calls } = fakeR2([listXml([{ key: 'old', size: 4 }])]);
    const client = r2Client(CONFIG, { capBytes: 10, fetch: fake, clock: CLOCK });
    await client.measure();
    await client.put('one', ABC, PUT);  // 4 + 3 = 7
    await client.put('two', ABC, PUT);  // 7 + 3 = 10, at the cap
    await expect(client.put('three', new Uint8Array(1), PUT)).rejects.toThrow(/would pass the 10-byte cap/);
    expect(calls.map(call => call.method)).toEqual(['GET', 'PUT', 'PUT']);
  });

  it('counts the record’s bytes when they are more than the listing’s', async () => {
    const { fake, calls } = fakeR2([listXml([{ key: 'old', size: 4 }])]);
    const client = r2Client(CONFIG, { capBytes: 10, knownBytes: 9, fetch: fake, clock: CLOCK });
    await client.measure();
    expect(client.usage().counted).toBe(9);
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/would pass/);
    expect(calls.map(call => call.method)).toEqual(['GET']);
  });

  it('counts a PUT that R2 answered with an error as written', async () => {
    const calls: string[] = [];
    const failing = (async (_url: URL, init: RequestInit) => {
      calls.push(init.method!);
      return init.method === 'GET' ? new Response(listXml([]), { status: 200 }) : new Response('<Error><Code>InternalError</Code></Error>', { status: 500 });
    }) as unknown as typeof fetch;
    const client = r2Client(CONFIG, { capBytes: 5, fetch: failing, clock: CLOCK });
    await client.measure();
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/HTTP 500/);
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/would pass the 5-byte cap/);
    expect(calls).toEqual(['GET', 'PUT']);
  });

  it(`never takes a cap above ${FREE_TIER_CAP_BYTES} bytes`, async () => {
    const { fake } = fakeR2([listXml([])]);
    const client = r2Client(CONFIG, { capBytes: 50_000_000_000, knownBytes: FREE_TIER_CAP_BYTES - 3, fetch: fake, clock: CLOCK });
    expect(client.capBytes).toBe(FREE_TIER_CAP_BYTES);
    await client.measure();
    await client.put('k', ABC, PUT);
    await expect(client.put('k2', new Uint8Array(1), PUT)).rejects.toThrow(/would pass the 9000000000-byte cap/);
  });
});

describe('the operation budget', () => {
  it('counts HEAD as Class B and every other request as Class A', () => {
    expect(['HEAD', 'head'].map(operationClass)).toEqual(['B', 'B']);
    expect(['PUT', 'GET', 'POST', 'DELETE', 'COPY'].map(operationClass)).toEqual(['A', 'A', 'A', 'A', 'A']);
  });

  it('refuses the request after the limit without sending it, per class', async () => {
    const { fake, calls } = fakeR2();
    const client = r2Client(CONFIG, { capBytes: 1_000, budget: operationBudget({ A: 2, B: 1 }), fetch: fake, clock: CLOCK });
    await client.measure();                                                // A 1
    await client.put('one', ABC, PUT);                                      // A 2
    await expect(client.put('two', ABC, PUT)).rejects.toBeInstanceOf(BudgetSpent);
    await client.head('one');                                               // B 1
    await expect(client.head('two')).rejects.toThrow(/Class B budget for this run \(1 requests\) is spent/);
    expect(calls.map(call => call.method)).toEqual(['GET', 'PUT', 'HEAD']);
    expect(client.usage().requests).toEqual({ A: 2, B: 1 });
  });

  it('charges each listing page as Class A, so a listing past the budget is no measurement', async () => {
    const { fake, calls } = fakeR2([listXml([{ key: 'a', size: 1 }], 'next'), listXml([])]);
    const client = r2Client(CONFIG, { capBytes: 1_000, budget: operationBudget({ A: 1, B: 0 }), fetch: fake, clock: CLOCK });
    await expect(client.measure()).rejects.toBeInstanceOf(BudgetSpent);
    expect(calls).toHaveLength(1);
    await expect(client.put('k', ABC, PUT)).rejects.toThrow(/not measured/);
  });

  it('keeps a month of daily runs under 1% of the free operations', () => {
    expect(RUN_BUDGET).toEqual({ A: 200, B: 200 });
    expect(31 * RUN_BUDGET.A).toBeLessThan(FREE_TIER_OPERATIONS.A / 100);
    expect(31 * RUN_BUDGET.B).toBeLessThan(FREE_TIER_OPERATIONS.B / 100);
  });
});

describe('the storage class', () => {
  it('sends STANDARD on every PUT and no other class on any request', async () => {
    const { fake, calls } = fakeR2([listXml([])]);
    const client = r2Client(CONFIG, { capBytes: 1_000, fetch: fake, clock: CLOCK });
    await client.measure();
    await client.head('one');
    await client.put('one', ABC, PUT);
    await client.put('two', ABC, PUT);
    expect(STORAGE_CLASS).toBe('STANDARD');
    for (const call of calls) {
      const classes = Object.entries(call.headers).filter(([name]) => name.toLowerCase() === 'x-amz-storage-class').map(([, value]) => value);
      expect(classes).toEqual(call.method === 'PUT' ? ['STANDARD'] : []);
    }
  });

  it('refuses headers naming any other class, whatever the header’s case', () => {
    expect(() => assertStandardOnly({ 'x-amz-storage-class': 'STANDARD', 'content-type': 'x' })).not.toThrow();
    expect(() => assertStandardOnly({ 'content-type': 'x' })).not.toThrow();
    for (const value of ['STANDARD_IA', 'standard_ia', 'standard', 'GLACIER', 'REDUCED_REDUNDANCY', 'InfrequentAccess', '']) {
      expect(() => assertStandardOnly({ 'x-amz-storage-class': value })).toThrow(/writes only STANDARD/);
      expect(() => assertStandardOnly({ 'X-Amz-Storage-Class': value })).toThrow(/writes only STANDARD/);
    }
  });
});
