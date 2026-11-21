import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TrustAnchors } from '../../lib/trust.ts';
import { parseAssertions, verifySnapAssertions } from '../../sensors/verify/snap.ts';
import type { Check } from '../../sensors/verify/types.ts';
import { here, trust as loadTrust } from '../sensors/helpers.ts';

const NOW = new Date('2026-11-20T12:00:00.000Z');
const read = (name: string) => readFile(here(`../../testdata/verify/snap/${name}`), 'utf8');
const byId = (checks: Check[]) => Object.fromEntries(checks.map(check => [check.id, check]));

describe('snap assertions', () => {
  let anchors: TrustAnchors;
  let root: string;
  let revision: string;
  let storeKey: string;
  let declaration: string;
  let file: { sha3_384: string; size: number };
  beforeAll(async () => {
    anchors = await loadTrust();
    root = await readFile(here('../../ledger/trust/snap/canonical-root.account-key'), 'utf8');
    revision = await read('revision-99.snap-revision');
    storeKey = await read('store.account-key');
    declaration = await read('spotify.snap-declaration');
    const [parsed] = parseAssertions(revision);
    file = { sha3_384: Buffer.from(parsed!.headers['snap-sha3-384']!, 'base64url').toString('hex'), size: Number(parsed!.headers['snap-size']) };
  });

  it('verifies revision 99 through the store key to the pinned root', () => {
    const checks = byId(verifySnapAssertions([revision, storeKey, declaration].join('\n'), anchors, root, file, NOW));
    expect(checks['snap.assertion-chain']?.status).toBe('pass');
    expect(checks['snap.identity']?.status).toBe('pass');
    expect(checks['snap.revision-digest']?.status).toBe('pass');
  });

  it('fails the chain for a changed header, a missing signing key and another pinned root', () => {
    const tampered = revision.replace(/^snap-size: \d+$/m, 'snap-size: 150822913');
    expect(byId(verifySnapAssertions([tampered, storeKey].join('\n'), anchors, root, file, NOW))['snap.assertion-chain']?.status).toBe('fail');
    expect(byId(verifySnapAssertions(revision, anchors, root, file, NOW))['snap.assertion-chain']?.detail).toMatch(/no account-key assertion/);
    const otherRoot = structuredClone(anchors);
    otherRoot.snap.rootKey.sha3_384 = 'A'.repeat(64);
    expect(byId(verifySnapAssertions([revision, storeKey].join('\n'), otherRoot, root, file, NOW))['snap.assertion-chain']?.detail).toMatch(/not the pinned/);
  });

  it('fails the chain when the root assertion is altered', () => {
    const alteredRoot = root.replace('display-name', 'display-nam3').replace('name: root', 'name: r00t');
    expect(byId(verifySnapAssertions([revision, storeKey].join('\n'), anchors, alteredRoot, file, NOW))['snap.assertion-chain']?.status).toBe('fail');
  });

  it('fails the identity for another developer and the digest for other bytes', () => {
    const otherDeveloper = structuredClone(anchors);
    otherDeveloper.snap.developerId = 'someone-else';
    expect(byId(verifySnapAssertions([revision, storeKey, declaration].join('\n'), otherDeveloper, root, file, NOW))['snap.identity']?.status).toBe('fail');
    const checks = byId(verifySnapAssertions([revision, storeKey].join('\n'), anchors, root, { ...file, sha3_384: '0'.repeat(96) }, NOW));
    expect(checks['snap.revision-digest']?.status).toBe('fail');
    expect(byId(verifySnapAssertions([revision, storeKey].join('\n'), anchors, root, { ...file, size: 1 }, NOW))['snap.revision-digest']?.detail).toMatch(/size/);
  });

  it('reports a malformed stream as a failed chain', () => {
    expect(verifySnapAssertions('type: snap-revision\nno blank line', anchors, root, file, NOW)).toEqual([expect.objectContaining({ id: 'snap.assertion-chain', status: 'fail' })]);
    expect(verifySnapAssertions(revision.replace(/\n\n[\s\S]*$/, '\n\n!!!'), anchors, root, file, NOW)[0]?.status).toBe('fail');
  });
});
