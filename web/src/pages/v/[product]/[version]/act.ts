import type { APIRoute } from 'astro';
import { isReaction } from '../../../../../../lib/site/social.ts';
import * as act from '../../../../lib/community-actions.ts';
import { community, signInHref, viewerOf } from '../../../../lib/community.ts';
import { addressOf, answer, releaseOf } from '../../../../lib/community-http.ts';

/**
 * POST, form-encoded: the release page's community actions (like, react, comment, reply, edit,
 * delete, report, review). Astro's checkOrigin refuses cross-site form posts. A plain form gets a
 * 303 back to the page with a notice; the page's script sends `Accept: application/json` and gets
 * the outcome as JSON, so a refused comment keeps its draft.
 */
export const POST: APIRoute = async context => {
  const found = await releaseOf(context.params);
  if (!found) return new Response('No such release.\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const page = `/v/${found.release.product}/${found.release.version}`;
  const json = (context.request.headers.get('accept') ?? '').includes('application/json');

  if (!community().auth) return json ? answer(404, { error: 'not_configured', message: 'Sign-in is not configured on this server.' }) : context.redirect(page, 303);
  const user = await viewerOf(context.request);
  if (!user) {
    const signIn = signInHref(`${page}#community`);
    return json ? answer(401, { error: 'sign_in', message: 'Sign in first.', signIn }) : context.redirect(signIn, 303);
  }

  const form = await context.request.formData().catch(() => null);
  const field = (name: string): string | undefined => {
    const value = form?.get(name);
    return typeof value === 'string' ? value : undefined;
  };
  const id = /^\d{1,12}$/.test(field('id') ?? '') ? field('id')! : '';
  const on = field('on') === '1' ? true : field('on') === '0' ? false : null;
  const address = addressOf(context);
  let anchor = 'community';
  let result: act.Outcome<object>;

  switch (field('intent')) {
    case 'like':
      result = act.setLike(user, found.key, field('value') !== '0', address);
      break;
    case 'react': {
      const emoji = field('emoji');
      result = isReaction(emoji) ? act.setReaction(user, found.key, emoji, on ?? !act.hasReaction(user, found.key, emoji), address) : { ok: false, code: 'bad_request' };
      break;
    }
    case 'comment-react':
      result = act.setCommentReaction(user, id, field('emoji'), on ?? 'toggle', address);
      anchor = `c-${id}`;
      break;
    case 'comment': {
      const posted = act.postComment(user, found.key, field('body'), field('parent') || null, address);
      if (posted.ok) anchor = `c-${posted.value.id}`;
      result = posted;
      break;
    }
    case 'edit':
      result = act.editComment(user, id, field('body'), address);
      anchor = `c-${id}`;
      break;
    case 'delete':
      result = act.deleteComment(user, id);
      break;
    case 'report':
      result = act.reportComment(user, id, field('reason'), address);
      break;
    case 'review':
      result = act.reviewComment(user, id, field('keep') === '1');
      break;
    default:
      result = { ok: false, code: 'bad_request' };
  }

  const location = result.code ? `${page}?notice=${result.code}#${anchor}` : `${page}#${anchor}`;
  if (!json) return context.redirect(location, 303);
  if (result.ok) return answer(200, { ok: true, location, ...(result.code ? { notice: result.code, message: act.NOTICES[result.code] } : {}), ...result.value });
  const retry: Record<string, string> = result.retryAfterMs ? { 'retry-after': String(Math.ceil(result.retryAfterMs / 1000)) } : {};
  return answer(act.statusOf(result.code), { error: result.code, message: act.NOTICES[result.code] }, retry);
};
