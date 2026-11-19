import { createHash } from 'node:crypto';
import type { ClaimedDigests } from '../types.ts';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Google Cloud Storage sends a plain object's MD5 as its ETag; a composite object's ETag is not an MD5. */
export function md5FromEtag(etag: string | null | undefined): ClaimedDigests {
  const match = /^"?([0-9a-f]{32})"?$/i.exec(etag ?? '');
  return match ? { md5: match[1]!.toLowerCase() } : {};
}
