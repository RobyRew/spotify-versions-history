import { describe, expect, it } from 'vitest';
import { r2Client, r2ConfigFromEnv, signV4 } from '../../sensors/storage/r2.ts';

describe('AWS Signature V4', () => {
  it('matches AWS’s published GET Object example', () => {
    // docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-header-based-auth.html, "Example: GET Object".
    const authorization = signV4({
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9',
        'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        'x-amz-date': '20130524T000000Z',
      },
      payloadSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      service: 's3',
      amzDate: '20130524T000000Z',
    });
    expect(authorization).toBe('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  });
});

describe('R2 client', () => {
  it('reads its config from the environment only when all three secrets are set', () => {
    expect(r2ConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b' })).toBeNull();
    expect(r2ConfigFromEnv({ CLOUDFLARE_ACCOUNT_ID: 'a', R2_ACCESS_KEY_ID: 'b', R2_SECRET_ACCESS_KEY: 'c' })).toEqual({ accountId: 'a', accessKeyId: 'b', secretAccessKey: 'c', bucket: 'spotify-versions-archive' });
  });

  it('sends signed HEAD and PUT requests to the bucket path, with the body’s SHA-256', async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), method: init.method!, headers: init.headers as Record<string, string> });
      return init.method === 'HEAD' ? new Response(null, { status: calls.length === 1 ? 404 : 200, headers: { 'content-length': '3' } }) : new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const client = r2Client({ accountId: 'acct', accessKeyId: 'AK', secretAccessKey: 'SK', bucket: 'b' }, fake, () => new Date('2026-11-26T12:00:00Z'));
    expect(await client.head('sha256/abc/file.exe')).toBeNull();
    expect(await client.head('sha256/abc/file.exe')).toEqual({ size: 3 });
    const sha = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    await client.put('sha256/abc/file.exe', new TextEncoder().encode('abc'), { sha256: sha, contentType: 'application/octet-stream', contentDisposition: 'attachment; filename="file.exe"' });
    const put = calls[2]!;
    expect(put.url).toBe('https://acct.r2.cloudflarestorage.com/b/sha256/abc/file.exe');
    expect(put.headers['x-amz-content-sha256']).toBe(sha);
    expect(put.headers['x-amz-checksum-sha256']).toBe(Buffer.from(sha, 'hex').toString('base64'));
    expect(put.headers['x-amz-date']).toBe('20261126T120000Z');
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/20261126\/auto\/s3\/aws4_request, SignedHeaders=content-disposition;content-length;content-type;host;x-amz-checksum-sha256;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  });
});
