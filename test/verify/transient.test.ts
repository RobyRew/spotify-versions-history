import { describe, expect, it } from 'vitest';
import { DigestMismatchError } from '../../sensors/capture/download.ts';
import { isTransientFailure } from '../../sensors/verify/pipeline.ts';

describe('isTransientFailure', () => {
  it('retries dropped connections and timeouts, not answers', () => {
    expect(isTransientFailure(new TypeError('fetch failed'))).toBe(true);
    expect(isTransientFailure(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }))).toBe(true);
    expect(isTransientFailure(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientFailure(new Error('https://x: HTTP 404'))).toBe(false);
    expect(isTransientFailure(new Error('the file changed while it was being downloaded'))).toBe(false);
    expect(isTransientFailure('fetch failed')).toBe(false);
  });

  it('does not retry a digest mismatch', () => {
    const mismatch = Object.create(DigestMismatchError.prototype) as Error;
    Object.assign(mismatch, { name: 'DigestMismatchError', message: 'sha256 is a, the listing says b' });
    expect(isTransientFailure(mismatch)).toBe(false);
  });
});
