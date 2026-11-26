/**
 * The community rules of the archive's website, as pure functions: what a comment may contain and
 * how it is shown, which links are clickable, how often someone may post, how a download is counted
 * once per visitor and day, and the request checks the write routes share. The database side is
 * social-store.ts; the website wires both to requests.
 */
import { createHash } from 'node:crypto';

/** The quick reactions, ChatForge's six. Anything else is refused. */
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'] as const;
export type Reaction = (typeof REACTIONS)[number];
export const isReaction = (value: unknown): value is Reaction => typeof value === 'string' && (REACTIONS as readonly string[]).includes(value);

export const COMMENT_MAX = 2000;
/** How long an author may edit or delete their comment as the author (moderators: always). */
export const EDIT_WINDOW_MS = 15 * 60_000;
/** Distinct reports that hide a comment until a moderator reviews it. */
export const REPORTS_TO_HIDE = 3;
export const REPORT_REASONS = ['spam', 'abuse', 'malware', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const isReportReason = (value: unknown): value is ReportReason => typeof value === 'string' && (REPORT_REASONS as readonly string[]).includes(value);

/** A release's key in the social tables: `desktop/1.3.10.2586`. */
export const releaseKey = (release: { product: string; version: string }): string => `${release.product}/${release.version}`;

// ── Comment text ────────────────────────────────────────────────────────────────────────────────

// Control characters other than tab and newline, and the bidirectional overrides that can make a
// comment read differently from what it contains.
const STRIP = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‎‏‪-‮⁦-⁩]/g;

export type CommentCheck = { ok: true; body: string } | { ok: false; problem: 'empty' | 'too_long' };

/**
 * Normalizes a submitted comment: newlines, stripped control characters, no trailing spaces, at most
 * one blank line in a row. Input far over the limit is refused before any of that runs, and every
 * step is linear in the input (a `[ \t]+$` regex backtracks quadratically on a long run of spaces).
 */
export function normalizeComment(raw: unknown): CommentCheck {
  if (typeof raw !== 'string') return { ok: false, problem: 'empty' };
  if (raw.length > COMMENT_MAX * 2) return { ok: false, problem: 'too_long' };
  const body = raw
    .replace(/\r\n?/g, '\n')
    .replace(STRIP, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!body) return { ok: false, problem: 'empty' };
  if (body.length > COMMENT_MAX) return { ok: false, problem: 'too_long' };
  return { ok: true, body };
}

/** Hosts whose links are clickable (the host itself or any subdomain), over https only. */
export const LINK_HOSTS = ['spotify.com', 'scdn.co', 'robyrew.com', 'github.com'] as const;

export function isAllowedLink(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return LINK_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`));
}

export type InlineNode = { type: 'text'; text: string } | { type: 'code'; text: string } | { type: 'link'; href: string; text: string } | { type: 'break' };
export type CommentBlock = { type: 'paragraph'; nodes: InlineNode[] } | { type: 'code'; text: string };

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;

function linkify(text: string, out: InlineNode[]): void {
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    // Trailing punctuation belongs to the sentence, as does a closing bracket with no opening one.
    let found = match[0];
    while (found.length && '.,;:!?'.includes(found.at(-1)!)) found = found.slice(0, -1);
    if (found.endsWith(')') && !found.includes('(')) found = found.slice(0, -1);
    const start = match.index;
    if (start > last) out.push({ type: 'text', text: text.slice(last, start) });
    out.push(isAllowedLink(found) ? { type: 'link', href: found, text: found } : { type: 'text', text: found });
    last = start + found.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
}

function inline(lines: readonly string[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) nodes.push({ type: 'break' });
    let last = 0;
    for (const match of line.matchAll(/`([^`]+)`/g)) {
      if (match.index > last) linkify(line.slice(last, match.index), nodes);
      nodes.push({ type: 'code', text: match[1]! });
      last = match.index + match[0].length;
    }
    if (last < line.length) linkify(line.slice(last), nodes);
  });
  return nodes;
}

/**
 * A comment as blocks to render: paragraphs (text, `inline code`, allowlisted links, line breaks)
 * and fenced code blocks. Nothing in it is HTML; the page escapes every string it prints.
 */
export function parseComment(body: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', nodes: inline(paragraph) });
    paragraph = [];
  };
  for (const line of body.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (code) {
        blocks.push({ type: 'code', text: code.join('\n') });
        code = null;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) code.push(line);
    else if (!line.trim()) flush();
    else paragraph.push(line);
  }
  if (code) blocks.push({ type: 'code', text: code.join('\n') });
  flush();
  return blocks;
}

// ── Rate limits ─────────────────────────────────────────────────────────────────────────────────

export const COMMENT_LIMITS = {
  perHour: 10,
  newAccountPerHour: 3,
  newAccountMs: 24 * 3_600_000,
  gapMs: 30_000,
} as const;

export type LimitCheck = { ok: true } | { ok: false; reason: 'gap' | 'hourly'; retryAfterMs: number };

/**
 * Whether a user may post another comment now. `recent` holds the creation times of their comments
 * in the last hour, deleted ones included, so deleting does not buy more posts.
 */
export function commentAllowed(now: number, accountCreatedAt: number, recent: readonly number[]): LimitCheck {
  const hour = recent.filter(time => time > now - 3_600_000).sort((a, b) => a - b);
  const newest = hour.at(-1);
  if (newest !== undefined && now - newest < COMMENT_LIMITS.gapMs) return { ok: false, reason: 'gap', retryAfterMs: COMMENT_LIMITS.gapMs - (now - newest) };
  const cap = now - accountCreatedAt < COMMENT_LIMITS.newAccountMs ? COMMENT_LIMITS.newAccountPerHour : COMMENT_LIMITS.perHour;
  if (hour.length >= cap) return { ok: false, reason: 'hourly', retryAfterMs: hour[hour.length - cap]! + 3_600_000 - now };
  return { ok: true };
}

/**
 * In-memory token buckets, one per key: `capacity` actions, refilled at `perMinute`. A bucket that
 * has refilled completely is the same as no bucket, so once the map holds more than `sweepAbove`
 * keys those are dropped, at most once a minute.
 */
export function tokenBuckets(capacity: number, perMinute: number, sweepAbove = 10_000) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const level = (bucket: { tokens: number; at: number }, now: number) => Math.min(capacity, bucket.tokens + ((now - bucket.at) * perMinute) / 60_000);
  let sweptAt = -Infinity;
  return {
    take(key: string, now: number): boolean {
      const bucket = buckets.get(key) ?? { tokens: capacity, at: now };
      bucket.tokens = level(bucket, now);
      bucket.at = now;
      const allowed = bucket.tokens >= 1;
      if (allowed) bucket.tokens -= 1;
      buckets.set(key, bucket);
      if (buckets.size > sweepAbove && now - sweptAt >= 60_000) {
        sweptAt = now;
        for (const [name, value] of buckets) if (level(value, now) >= capacity) buckets.delete(name);
      }
      return allowed;
    },
    get size(): number {
      return buckets.size;
    },
  };
}

// ── Downloads ───────────────────────────────────────────────────────────────────────────────────

/** A UTC day, `YYYY-MM-DD`. */
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const BOTS = /bot|crawl|spider|slurp|preview|monitor|uptime|headless|lighthouse|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;

/** Crawlers, link previews, monitors and requests with no User-Agent, which are not downloads. */
export const isBot = (agent: string | null): boolean => !agent?.trim() || BOTS.test(agent);

/**
 * The visitor's address behind the one proxy in front of the app (Traefik appends the address it
 * saw to X-Forwarded-For, so the last entry is the one a client cannot forge), else the socket's.
 */
export function clientAddress(forwardedFor: string | null, socket: string | null): string {
  const last = forwardedFor?.split(',').map(part => part.trim()).filter(Boolean).at(-1);
  return (last ?? socket ?? 'unknown').replace(/^::ffff:/, '');
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The eight hextets of an IPv6 address with `::` expanded (and a dotted IPv4 tail converted), or null. */
export function ipv6Hextets(address: string): string[] | null {
  let text = address.toLowerCase().split('%')[0]!;
  const tail4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (tail4) {
    const [a, b, c, d] = tail4.slice(1).map(Number) as [number, number, number, number];
    if ([a, b, c, d].some(part => part > 255)) return null;
    text = `${text.slice(0, tail4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0 || (halves.length === 2 && fill === 0)) return null;
  const all = [...head, ...Array.from({ length: fill }, () => '0'), ...rest];
  if (all.length !== 8 || all.some(part => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return all.map(part => part.replace(/^0+(?=.)/, ''));
}

/** The network a download is capped per: an IPv4 /24 or an IPv6 /48. */
export function subnetOf(address: string): string {
  if (IPV4.test(address)) return address.split('.').slice(0, 3).join('.') + '.0/24';
  const hextets = address.includes(':') ? ipv6Hextets(address) : null;
  return hextets ? `${hextets.slice(0, 3).join(':')}::/48` : address;
}

/**
 * The key of the per-network write limits: an IPv4 address, or an IPv6 /64 (one home or server line
 * holds a whole /64, and a new address in it costs nothing).
 */
export function rateKeyOf(address: string): string {
  if (IPV4.test(address)) return address;
  const hextets = address.includes(':') ? ipv6Hextets(address) : null;
  return hextets ? `${hextets.slice(0, 4).join(':')}::/64` : address;
}

/** At most this many counted downloads of one file per network and day. */
export const SUBNET_DAILY_CAP = 20;

/** A visitor's key for one day: no address or User-Agent is stored, and the salt changes daily. */
export const visitorKey = (salt: string, address: string, agent: string): string =>
  createHash('sha256').update(`${salt}\n${address}\n${agent}`).digest('base64url');

// ── Requests ────────────────────────────────────────────────────────────────────────────────────

/**
 * A write sent by the site's own script: same origin (Origin, else Sec-Fetch-Site) and a JSON body,
 * which a cross-site form cannot send without a preflight the site never grants.
 */
export function isSameOriginJson(headers: Headers, origin: string): boolean {
  const sentOrigin = headers.get('origin');
  const site = headers.get('sec-fetch-site');
  const sameOrigin = sentOrigin ? sentOrigin === origin : site === 'same-origin';
  return sameOrigin && (headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/** Avatars are shown only from these origins; anything else becomes initials. */
export function safeAvatar(url: unknown, origins: readonly string[]): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && origins.includes(parsed.origin) ? parsed.href : null;
  } catch {
    return null;
  }
}
