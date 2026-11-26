import { describe, expect, it } from 'vitest';
import { filterReleases, type ReleaseCounts, type ReleaseView } from '../../lib/site/model.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSocialStore, openSocialDb, snapshotDb } from '../../lib/site/social-store.ts';
import {
  clientAddress, commentAllowed, COMMENT_LIMITS, ipv6Hextets, isAllowedLink, isBot, isSameOriginJson, normalizeComment, parseComment,
  rateKeyOf, safeAvatar, subnetOf, tokenBuckets, visitorKey,
} from '../../lib/site/social.ts';

const HOUR = 3_600_000;

describe('comment text', () => {
  it('normalizes newlines, strips control and bidi characters, caps blank lines and length', () => {
    expect(normalizeComment('  hi\r\nthere ‮evil\u0007\n\n\n\nend  ')).toEqual({ ok: true, body: 'hi\nthere evil\n\nend' });
    expect(normalizeComment('   \n ')).toEqual({ ok: false, problem: 'empty' });
    expect(normalizeComment(42)).toEqual({ ok: false, problem: 'empty' });
    expect(normalizeComment('x'.repeat(2001))).toEqual({ ok: false, problem: 'too_long' });
    expect(normalizeComment('x'.repeat(2000)).ok).toBe(true);
  });

  it('stays linear on long runs of spaces, refusing input far over the limit before normalizing', () => {
    const started = performance.now();
    expect(normalizeComment(' '.repeat(65_000) + 'x')).toEqual({ ok: false, problem: 'too_long' });
    expect(normalizeComment(' '.repeat(3_990) + 'x')).toEqual({ ok: true, body: 'x' });
    expect(normalizeComment(`a${' '.repeat(1_900)}\nb\t \nc`)).toEqual({ ok: true, body: 'a\nb\nc' });
    const link = parseComment(`https://github.com/a${'.'.repeat(1_900)}x`);
    expect(link[0]?.type).toBe('paragraph');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('makes only https links to the allowlisted hosts clickable', () => {
    expect(isAllowedLink('https://community.spotify.com/t5/x')).toBe(true);
    expect(isAllowedLink('https://github.com/RobyRew')).toBe(true);
    expect(isAllowedLink('https://id.robyrew.com/@a')).toBe(true);
    expect(isAllowedLink('http://github.com/')).toBe(false);
    expect(isAllowedLink('https://github.com.evil.example/')).toBe(false);
    expect(isAllowedLink('https://evilgithub.com/')).toBe(false);
    expect(isAllowedLink('https://user:pw@github.com/')).toBe(false);
    expect(isAllowedLink('https://github.com:8443/')).toBe(false);
    expect(isAllowedLink('javascript:alert(1)')).toBe(false);
  });

  it('parses paragraphs, line breaks, inline code, fences and links, keeping sentence punctuation outside links', () => {
    const blocks = parseComment('Works on `arm64`.\nSee https://github.com/x/y. Or https://evil.example/z\n\n```\nspctl -a\n```\nafter');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        nodes: [
          { type: 'text', text: 'Works on ' }, { type: 'code', text: 'arm64' }, { type: 'text', text: '.' }, { type: 'break' },
          { type: 'text', text: 'See ' }, { type: 'link', href: 'https://github.com/x/y', text: 'https://github.com/x/y' },
          { type: 'text', text: '. Or ' }, { type: 'text', text: 'https://evil.example/z' },
        ],
      },
      { type: 'code', text: 'spctl -a' },
      { type: 'paragraph', nodes: [{ type: 'text', text: 'after' }] },
    ]);
    expect(parseComment('```\nunclosed <b>')).toEqual([{ type: 'code', text: 'unclosed <b>' }]);
    expect(parseComment('(https://github.com/a)')[0]).toEqual({ type: 'paragraph', nodes: [{ type: 'text', text: '(' }, { type: 'link', href: 'https://github.com/a', text: 'https://github.com/a' }, { type: 'text', text: ')' }] });
  });
});

describe('limits', () => {
  const now = 10 * HOUR;
  const old = now - 30 * 24 * HOUR;

  it('needs half a minute between comments', () => {
    expect(commentAllowed(now, old, [now - 10_000])).toEqual({ ok: false, reason: 'gap', retryAfterMs: 20_000 });
    expect(commentAllowed(now, old, [now - COMMENT_LIMITS.gapMs])).toEqual({ ok: true });
  });

  it('allows ten an hour, three for an account younger than a day, counting what is passed in', () => {
    // Ten comments 50 to 23 minutes ago: the newest is past the gap, the hour is full until the
    // oldest is an hour old.
    const ten = Array.from({ length: 10 }, (_, index) => now - 50 * 60_000 + index * 3 * 60_000);
    expect(commentAllowed(now, old, ten.slice(0, 9))).toEqual({ ok: true });
    expect(commentAllowed(now, old, ten)).toEqual({ ok: false, reason: 'hourly', retryAfterMs: 10 * 60_000 });
    expect(commentAllowed(now, now - HOUR, [now - 50 * 60_000, now - 40 * 60_000, now - 30 * 60_000])).toMatchObject({ ok: false, reason: 'hourly', retryAfterMs: 10 * 60_000 });
    expect(commentAllowed(now, old, [now - 2 * HOUR])).toEqual({ ok: true });
  });

  it('refills token buckets over time', () => {
    const buckets = tokenBuckets(2, 60);
    expect([buckets.take('a', 0), buckets.take('a', 0), buckets.take('a', 0)]).toEqual([true, true, false]);
    expect(buckets.take('a', 1_000)).toBe(true);
    expect(buckets.take('b', 0)).toBe(true);
  });

  it('drops buckets that have refilled, at most once a minute, above the threshold', () => {
    const buckets = tokenBuckets(5, 60, 3);
    // Four keys at t=0: the first sweep runs and finds nothing refilled.
    for (const key of ['a', 'b', 'c', 'd']) buckets.take(key, 0);
    expect(buckets.size).toBe(4);
    // 30 s later every bucket has refilled, but a sweep ran less than a minute ago.
    buckets.take('e', 30_000);
    expect(buckets.size).toBe(5);
    // A minute after the first sweep: everything refilled goes; only the bucket just used stays.
    buckets.take('f', 61_000);
    expect(buckets.size).toBe(1);
  });
});

describe('requests and downloads', () => {
  it('accepts same-origin JSON writes only', () => {
    const origin = 'https://svh.example';
    const headers = (entries: Record<string, string>) => new Headers(entries);
    expect(isSameOriginJson(headers({ origin, 'content-type': 'application/json; charset=utf-8' }), origin)).toBe(true);
    expect(isSameOriginJson(headers({ 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }), origin)).toBe(true);
    expect(isSameOriginJson(headers({ origin: 'https://evil.example', 'content-type': 'application/json' }), origin)).toBe(false);
    expect(isSameOriginJson(headers({ origin, 'content-type': 'text/plain' }), origin)).toBe(false);
    expect(isSameOriginJson(headers({ 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }), origin)).toBe(false);
    expect(isSameOriginJson(headers({ 'content-type': 'application/json' }), origin)).toBe(false);
  });

  it('reads the address Traefik appended, groups networks and keys visitors without storing them', () => {
    expect(clientAddress('6.6.6.6, 203.0.113.9', '10.0.0.2')).toBe('203.0.113.9');
    expect(clientAddress(null, '::ffff:192.0.2.4')).toBe('192.0.2.4');
    expect(subnetOf('203.0.113.9')).toBe('203.0.113.0/24');
    expect(subnetOf('2001:db8:abcd:12::1')).toBe('2001:db8:abcd::/48');
    // Two text forms of one /48 get one key once :: is expanded.
    expect(subnetOf('2001:db8:0:5::1')).toBe('2001:db8:0::/48');
    expect(subnetOf('2001:db8::1:0:0:1')).toBe('2001:db8:0::/48');
    expect(ipv6Hextets('::ffff:192.0.2.1')).toEqual(['0', '0', '0', '0', '0', 'ffff', 'c000', '201']);
    expect([ipv6Hextets('1::2::3'), ipv6Hextets('12345::1'), ipv6Hextets('1:2:3')]).toEqual([null, null, null]);
    // Write limits: an IPv4 address, or the /64 an IPv6 address is in.
    expect(rateKeyOf('203.0.113.9')).toBe('203.0.113.9');
    expect(rateKeyOf('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(rateKeyOf('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    const key = visitorKey('salt', '203.0.113.9', 'Firefox');
    expect(key).not.toContain('203.0.113');
    expect(visitorKey('other', '203.0.113.9', 'Firefox')).not.toBe(key);
    expect([isBot('Googlebot/2.1'), isBot(''), isBot(null), isBot('Mozilla/5.0 (Macintosh) Safari/605')]).toEqual([true, true, true, false]);
  });

  it('shows avatars from the allowed origins only', () => {
    expect(safeAvatar('https://id.robyrew.com/avatars/a.webp', ['https://id.robyrew.com'])).toBe('https://id.robyrew.com/avatars/a.webp');
    expect(safeAvatar('https://tracker.example/p.png', ['https://id.robyrew.com'])).toBeNull();
    expect(safeAvatar('http://id.robyrew.com/a.webp', ['http://id.robyrew.com'])).toBeNull();
    expect(safeAvatar(undefined, ['https://id.robyrew.com'])).toBeNull();
  });
});

function store(start = 1_800_000_000_000) {
  let now = start;
  const social = createSocialStore(openSocialDb(':memory:'), () => now);
  const user = (id: string, roles: string[] = []) => social.upsertUser({ id, handle: id, name: null, avatar: null, roles });
  return { social, user, tick: (ms: number) => (now += ms), now: () => now };
}

describe('social store', () => {
  it('counts likes and reactions per person, in the quick-reaction order', () => {
    const { social, user } = store();
    user('alice');
    user('bob');
    expect(social.setLike('desktop/1', 'alice', true)).toEqual({ liked: true, count: 1 });
    expect(social.setLike('desktop/1', 'alice', true)).toEqual({ liked: true, count: 1 });
    expect(social.setLike('desktop/1', 'bob', true).count).toBe(2);
    social.setReaction('desktop/1', 'bob', '🎉', true);
    social.setReaction('desktop/1', 'alice', '👍', true);
    social.setReaction('desktop/1', 'bob', '👍', true);
    const seen = social.releaseSocial('desktop/1', { id: 'alice', moderator: false });
    expect(seen.liked).toBe(true);
    expect(seen.reactions).toEqual([{ emoji: '👍', count: 2, mine: true }, { emoji: '🎉', count: 1, mine: false }]);
    expect(social.setReaction('desktop/1', 'alice', '👍', false)).toEqual({ emoji: '👍', count: 1, mine: false });
    expect(social.setLike('desktop/1', 'alice', false)).toEqual({ liked: false, count: 1 });
  });

  it('keeps replies one level deep and shows a deleted parent only above live replies', () => {
    const { social, user, tick } = store();
    user('alice');
    user('bob');
    const top = social.addComment('desktop/1', 'alice', 'first', null);
    expect(top.ok).toBe(true);
    const parent = top.ok ? top.value : 0;
    tick(1000);
    const reply = social.addComment('desktop/1', 'bob', 'reply', parent);
    expect(reply.ok).toBe(true);
    expect(social.addComment('desktop/1', 'alice', 'nested', reply.ok ? reply.value : 0)).toEqual({ ok: false, error: 'bad_parent' });
    expect(social.addComment('desktop/2', 'alice', 'elsewhere', parent)).toEqual({ ok: false, error: 'bad_parent' });
    expect(social.deleteComment(parent, { id: 'alice', moderator: false }).ok).toBe(true);
    let view = social.releaseSocial('desktop/1', null);
    expect(view.comments).toHaveLength(1);
    expect(view.comments[0]).toMatchObject({ deleted: true, body: '' });
    expect(view.comments[0]!.replies.map(item => item.body)).toEqual(['reply']);
    expect(view.commentCount).toBe(1);
    social.deleteComment(reply.ok ? reply.value : 0, { id: 'bob', moderator: false });
    view = social.releaseSocial('desktop/1', null);
    expect(view.comments).toHaveLength(0);
  });

  it('lets the author change a comment for 15 minutes and a moderator at any time', () => {
    const { social, user, tick } = store();
    user('alice');
    user('mira', ['moderator']);
    user('bob');
    const posted = social.addComment('desktop/1', 'alice', 'text', null);
    const id = posted.ok ? posted.value : 0;
    expect(social.editComment(id, { id: 'bob', moderator: false }, 'x')).toEqual({ ok: false, error: 'forbidden' });
    expect(social.editComment(id, { id: 'alice', moderator: false }, 'edited').ok).toBe(true);
    tick(15 * 60_000 + 1);
    expect(social.editComment(id, { id: 'alice', moderator: false }, 'late')).toEqual({ ok: false, error: 'too_late' });
    expect(social.deleteComment(id, { id: 'alice', moderator: false })).toEqual({ ok: false, error: 'too_late' });
    expect(social.editComment(id, { id: 'mira', moderator: true }, 'moderated').ok).toBe(true);
    const comment = social.releaseSocial('desktop/1', null).comments[0]!;
    expect(comment.body).toBe('moderated');
    expect(comment.editedAt).not.toBeNull();
  });

  it('hides a comment after three reports, shows it to its author and moderators, and a review resets the count', () => {
    const { social, user, tick } = store();
    for (const id of ['alice', 'r1', 'r2', 'r3', 'r4']) user(id);
    user('mira', ['moderator']);
    const posted = social.addComment('desktop/1', 'alice', 'spammy', null);
    const id = posted.ok ? posted.value : 0;
    expect(social.reportComment(id, 'alice', 'spam')).toEqual({ ok: false, error: 'own_comment' });
    expect(social.reportComment(id, 'r1', 'spam')).toMatchObject({ ok: true, value: { hidden: false } });
    expect(social.reportComment(id, 'r1', 'abuse')).toMatchObject({ ok: true, value: { hidden: false } });
    social.reportComment(id, 'r2', 'spam');
    expect(social.reportComment(id, 'r3', 'spam')).toMatchObject({ ok: true, value: { hidden: true } });
    expect(social.releaseSocial('desktop/1', null).comments).toHaveLength(0);
    expect(social.releaseSocial('desktop/1', null).commentCount).toBe(0);
    expect(social.releaseSocial('desktop/1', { id: 'alice', moderator: false }).comments[0]).toMatchObject({ hidden: true, reports: 0 });
    expect(social.releaseSocial('desktop/1', { id: 'mira', moderator: true }).comments[0]).toMatchObject({ hidden: true, reports: 3 });
    expect(social.reportQueue({ id: 'mira', moderator: true })[0]).toMatchObject({ id, reasons: { spam: 2, abuse: 1 } });
    expect(social.reviewComment(id, { id: 'r4', moderator: false }, true)).toEqual({ ok: false, error: 'forbidden' });
    tick(1000);
    expect(social.reviewComment(id, { id: 'mira', moderator: true }, true).ok).toBe(true);
    expect(social.releaseSocial('desktop/1', null).comments).toHaveLength(1);
    expect(social.reportQueue({ id: 'mira', moderator: true })).toHaveLength(0);
    tick(1000);
    expect(social.reportComment(id, 'r4', 'spam')).toMatchObject({ ok: true, value: { hidden: false } });
  });

  it('refuses suspended and deleted accounts, and anonymizes a deleted one', () => {
    const { social, user } = store();
    user('alice');
    social.addComment('desktop/1', 'alice', 'kept text', null);
    social.setSuspended('alice', true);
    expect(social.addComment('desktop/1', 'alice', 'more', null)).toEqual({ ok: false, error: 'forbidden' });
    social.anonymizeUser('alice');
    const comment = social.releaseSocial('desktop/1', null).comments[0]!;
    expect(comment.body).toBe('kept text');
    expect(comment.author).toMatchObject({ handle: null, name: null, avatar: null, deleted: true });
  });

  it('counts a download once per visitor and day, caps a network, and prunes old dedupe rows', () => {
    const { social, tick } = store(Date.UTC(2026, 10, 26, 12));
    const record = (visitor: string, subnet = 'net-a') => social.recordDownload({ artifact: 'a1', release: 'desktop/1', visitor, subnet });
    expect(record('v1')).toBe(true);
    expect(record('v1')).toBe(false);
    for (let index = 2; index <= 20; index++) expect(record(`v${index}`)).toBe(true);
    expect(record('v21')).toBe(false);
    expect(record('w1', 'net-b')).toBe(true);
    expect(social.metrics().get('desktop/1')).toMatchObject({ downloads: 21, recentDownloads: 21 });
    tick(86_400_000);
    expect(record('v1')).toBe(true);
    tick(8 * 86_400_000);
    record('z1', 'net-z');
    expect(social.metrics().get('desktop/1')).toMatchObject({ downloads: 23, recentDownloads: 1 });
    const salt = social.dailySalt();
    expect(social.dailySalt()).toBe(salt);
  });
});

describe('snapshots', () => {
  it('writes a readable copy of the database next to a temporary name it removes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'svh-snap-'));
    try {
      const db = openSocialDb(join(directory, 'archive.db'));
      const social = createSocialStore(db);
      social.upsertUser({ id: 'alice', handle: 'alice', name: null, avatar: null, roles: [] });
      social.addComment('desktop/1', 'alice', "it's fine", null);
      const target = join(directory, "snap'shot", 'archive.db');
      snapshotDb(db, target);
      snapshotDb(db, target);
      const copy = new DatabaseSync(target, { readOnly: true });
      expect(copy.prepare('SELECT body FROM comments').get()).toEqual({ body: "it's fine" });
      copy.close();
      db.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('metric sorts', () => {
  const release = (version: string): ReleaseView => ({ product: 'desktop', version, fullVersion: `${version}.g0`, date: null, artifacts: [], platforms: [], signed: false, downloadable: false });
  const releases = ['1.3', '1.2', '1.1'].map(release);
  const counts = new Map<string, ReleaseCounts>([
    ['desktop/1.1', { downloads: 9, recentDownloads: 0, likes: 1, comments: 0 }],
    ['desktop/1.2', { downloads: 3, recentDownloads: 3, likes: 1, comments: 4 }],
  ]);
  it('orders by the metric, newest first among equals', () => {
    const order = (sort: Parameters<typeof filterReleases>[1]['sort']) => filterReleases(releases, { sort, counts }).map(item => item.version);
    expect(order('downloads')).toEqual(['1.1', '1.2', '1.3']);
    expect(order('trending')).toEqual(['1.2', '1.3', '1.1']);
    expect(order('liked')).toEqual(['1.2', '1.1', '1.3']);
    expect(order('discussed')).toEqual(['1.2', '1.3', '1.1']);
    expect(order('newest')).toEqual(['1.3', '1.2', '1.1']);
  });
});
