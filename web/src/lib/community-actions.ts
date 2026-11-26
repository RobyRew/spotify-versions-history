/**
 * Every community write, shared by the JSON API (/api/v2/…) and the release page's form endpoint
 * (/v/{product}/{version}/act, for browsers without script). Each returns an outcome with a notice
 * code; the routes turn it into JSON or a redirect.
 */
import type { ReactionCount } from '../../../lib/site/social-store.ts';
import { COMMENT_MAX, commentAllowed, isReaction, isReportReason, normalizeComment, rateKeyOf, type Reaction } from '../../../lib/site/social.ts';
import { community, type SiteUser } from './community.ts';

export const NOTICES = {
  posted: 'Your comment is posted.',
  edited: 'Your edit is saved.',
  deleted: 'The comment is deleted.',
  reported: 'Thanks. The moderators can see your report.',
  hidden: 'Thanks. The comment is hidden until a moderator reviews it.',
  kept: 'The comment is shown again.',
  removed: 'The comment is removed.',
  empty: 'Write something first.',
  too_long: `A comment can be at most ${COMMENT_MAX} characters.`,
  gap: 'Please wait half a minute between comments.',
  hourly: 'That is as many comments as an hour allows. Try again later.',
  busy: 'Too many requests from your network. Try again in a minute.',
  too_late: 'A comment can be changed for 15 minutes after it is posted.',
  forbidden: 'You can’t do that.',
  suspended: 'Your account is suspended.',
  bad_parent: 'That comment can’t be replied to.',
  own_comment: 'You can’t report your own comment.',
  not_found: 'That comment no longer exists.',
  bad_request: 'That request was not understood.',
} as const;
export type NoticeCode = keyof typeof NOTICES;
export const isNoticeCode = (value: unknown): value is NoticeCode => typeof value === 'string' && Object.hasOwn(NOTICES, value);
export const GOOD_NOTICES: ReadonlySet<NoticeCode> = new Set(['posted', 'edited', 'deleted', 'reported', 'hidden', 'kept', 'removed']);

const STATUS: Partial<Record<NoticeCode, number>> = {
  gap: 429, hourly: 429, busy: 429, forbidden: 403, suspended: 403, own_comment: 403, too_late: 403, not_found: 404,
};
export const statusOf = (code: NoticeCode): number => STATUS[code] ?? 400;

export type Outcome<T> = { ok: true; code: NoticeCode | null; value: T } | { ok: false; code: NoticeCode; retryAfterMs?: number };

const fail = (code: NoticeCode, retryAfterMs?: number): Outcome<never> => ({ ok: false, code, ...(retryAfterMs ? { retryAfterMs } : {}) });
const commentId = (raw: unknown): number | null => {
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,12}$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};
const viewerOf = (user: SiteUser) => ({ id: user.id, moderator: user.moderator });
const STORE_CODES = { not_found: 'not_found', forbidden: 'forbidden', too_late: 'too_late', bad_parent: 'bad_parent', own_comment: 'own_comment' } as const;

export function setLike(user: SiteUser, release: string, liked: boolean, address: string): Outcome<{ liked: boolean; count: number }> {
  const { store, reactLimit } = community();
  if (user.suspended) return fail('suspended');
  if (!reactLimit.take(`u:${user.id}`, Date.now()) || !reactLimit.take(`a:${rateKeyOf(address)}`, Date.now())) return fail('busy');
  return { ok: true, code: null, value: store.setLike(release, user.id, liked) };
}

export function setReaction(user: SiteUser, release: string, emoji: unknown, on: boolean, address: string): Outcome<ReactionCount> {
  const { store, reactLimit } = community();
  if (!isReaction(emoji)) return fail('bad_request');
  if (user.suspended) return fail('suspended');
  if (!reactLimit.take(`u:${user.id}`, Date.now()) || !reactLimit.take(`a:${rateKeyOf(address)}`, Date.now())) return fail('busy');
  return { ok: true, code: null, value: store.setReaction(release, user.id, emoji, on) };
}

/** Whether the person already reacted with this emoji: a no-script press toggles it. */
export function hasReaction(user: SiteUser, release: string, emoji: Reaction): boolean {
  return community().store.reactionMine(release, user.id, emoji);
}

export function setCommentReaction(user: SiteUser, rawId: unknown, emoji: unknown, on: boolean | 'toggle', address: string): Outcome<ReactionCount> {
  const { store, reactLimit } = community();
  const id = commentId(rawId);
  if (id === null || !isReaction(emoji)) return fail('bad_request');
  if (user.suspended) return fail('suspended');
  if (!reactLimit.take(`u:${user.id}`, Date.now()) || !reactLimit.take(`a:${rateKeyOf(address)}`, Date.now())) return fail('busy');
  const next = on === 'toggle' ? !store.commentReactionMine(id, user.id, emoji) : on;
  const result = store.setCommentReaction(id, user.id, emoji, next);
  return result.ok ? { ok: true, code: null, value: result.value } : fail(STORE_CODES[result.error]);
}

export function postComment(user: SiteUser, release: string, rawBody: unknown, rawParent: unknown, address: string): Outcome<{ id: number }> {
  const { store, writeLimit } = community();
  const now = Date.now();
  if (user.suspended) return fail('suspended');
  const body = normalizeComment(rawBody);
  if (!body.ok) return fail(body.problem);
  const parent = rawParent === undefined || rawParent === null || rawParent === '' ? null : commentId(rawParent);
  if (parent === null && rawParent !== undefined && rawParent !== null && rawParent !== '') return fail('bad_request');
  const limit = commentAllowed(now, user.createdAt, store.recentCommentTimes(user.id, now - 3_600_000));
  if (!limit.ok) return fail(limit.reason, limit.retryAfterMs);
  if (!writeLimit.take(`a:${rateKeyOf(address)}`, now)) return fail('busy');
  const result = store.addComment(release, user.id, body.body, parent);
  return result.ok ? { ok: true, code: 'posted', value: { id: result.value } } : fail(STORE_CODES[result.error]);
}

export function editComment(user: SiteUser, rawId: unknown, rawBody: unknown, address: string): Outcome<{ id: number }> {
  const { store, writeLimit } = community();
  const id = commentId(rawId);
  if (id === null) return fail('bad_request');
  if (user.suspended) return fail('suspended');
  const body = normalizeComment(rawBody);
  if (!body.ok) return fail(body.problem);
  if (!writeLimit.take(`a:${rateKeyOf(address)}`, Date.now())) return fail('busy');
  const result = store.editComment(id, viewerOf(user), body.body);
  return result.ok ? { ok: true, code: 'edited', value: { id } } : fail(STORE_CODES[result.error]);
}

export function deleteComment(user: SiteUser, rawId: unknown): Outcome<{ release: string }> {
  const id = commentId(rawId);
  if (id === null) return fail('bad_request');
  const result = community().store.deleteComment(id, viewerOf(user));
  return result.ok ? { ok: true, code: 'deleted', value: { release: result.value } } : fail(STORE_CODES[result.error]);
}

export function reportComment(user: SiteUser, rawId: unknown, reason: unknown, address: string): Outcome<{ hidden: boolean }> {
  const { store, writeLimit } = community();
  const id = commentId(rawId);
  if (id === null || !isReportReason(reason)) return fail('bad_request');
  if (user.suspended) return fail('suspended');
  if (!writeLimit.take(`a:${rateKeyOf(address)}`, Date.now())) return fail('busy');
  const result = store.reportComment(id, user.id, reason);
  return result.ok ? { ok: true, code: result.value.hidden ? 'hidden' : 'reported', value: { hidden: result.value.hidden } } : fail(STORE_CODES[result.error]);
}

export function reviewComment(user: SiteUser, rawId: unknown, keep: boolean): Outcome<{ release: string }> {
  const id = commentId(rawId);
  if (id === null) return fail('bad_request');
  if (!user.moderator) return fail('forbidden');
  const result = community().store.reviewComment(id, viewerOf(user), keep);
  return result.ok ? { ok: true, code: keep ? 'kept' : 'removed', value: { release: result.value } } : fail(STORE_CODES[result.error]);
}
