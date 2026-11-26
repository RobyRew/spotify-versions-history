/**
 * What the community routes share: the visitor's address, the release a URL names, and the checks
 * every JSON write passes (sign-in configured, same origin, a JSON body, a signed-in person).
 */
import type { APIContext } from 'astro';
import { findRelease, type ReleaseView } from '../../../lib/site/model.ts';
import type { CommentView } from '../../../lib/site/social-store.ts';
import { clientAddress, isSameOriginJson, releaseKey } from '../../../lib/site/social.ts';
import { community, SITE_ORIGIN, signInHref, viewerOf, type SiteUser } from './community.ts';
import { NOTICES, statusOf, type Outcome } from './community-actions.ts';
import { siteData } from './data.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const MAX_BODY = 16 * 1024;

export const answer = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });

export function addressOf(context: APIContext): string {
  let socket: string | null = null;
  try {
    socket = context.clientAddress;
  } catch {
    // Not every adapter or dev setup knows the socket address.
  }
  return clientAddress(context.request.headers.get('x-forwarded-for'), socket);
}

export async function releaseOf(params: Record<string, string | undefined>): Promise<{ release: ReleaseView; key: string } | null> {
  const data = await siteData();
  const release = findRelease(data.releases, params.product ?? '', params.version ?? '');
  return release ? { release, key: releaseKey(release) } : null;
}

/** The checks of a JSON write; a Response means it stops there. */
export async function jsonWrite(context: APIContext): Promise<{ user: SiteUser; body: Record<string, unknown> } | Response> {
  if (!community().auth) return answer(404, { error: 'not_configured', message: 'Sign-in is not configured on this server.' });
  if (!isSameOriginJson(context.request.headers, SITE_ORIGIN)) {
    return answer(403, { error: 'cross_origin', message: 'Writes are accepted from this site’s own pages, as JSON.' });
  }
  const user = await viewerOf(context.request);
  if (!user) {
    let back = '/';
    try {
      const referer = new URL(context.request.headers.get('referer') ?? '/', SITE_ORIGIN);
      if (referer.origin === SITE_ORIGIN) back = referer.pathname;
    } catch {
      // A malformed Referer: back to the home page.
    }
    return answer(401, { error: 'sign_in', message: 'Sign in first.', signIn: signInHref(back) });
  }
  let body: Record<string, unknown> = {};
  if (context.request.method !== 'DELETE') {
    const text = await context.request.text();
    if (text.length > MAX_BODY) return answer(413, { error: 'too_large', message: 'The request is too large.' });
    if (text) {
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        body = parsed as Record<string, unknown>;
      } catch {
        return answer(400, { error: 'bad_request', message: NOTICES.bad_request });
      }
    }
  }
  return { user, body };
}

export function outcomeResponse<T extends object>(result: Outcome<T>): Response {
  if (result.ok) return answer(200, { ok: true, ...(result.code ? { notice: result.code, message: NOTICES[result.code] } : {}), ...result.value });
  const retry: Record<string, string> = result.retryAfterMs ? { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) } : {};
  return answer(statusOf(result.code), { error: result.code, message: NOTICES[result.code] }, retry);
}

/** A comment as the public API shows it: no internal user id, no report counts. */
export function publicComment(comment: CommentView): object {
  return {
    id: comment.id,
    parentId: comment.parentId,
    author: comment.author.deleted ? { deleted: true } : { handle: comment.author.handle, name: comment.author.name, avatar: comment.author.avatar, moderator: comment.author.moderator },
    body: comment.body,
    createdAt: new Date(comment.createdAt).toISOString(),
    editedAt: comment.editedAt ? new Date(comment.editedAt).toISOString() : null,
    deleted: comment.deleted,
    reactions: comment.reactions.map(({ emoji, count }) => ({ emoji, count })),
    replies: comment.replies.map(publicComment),
  };
}
