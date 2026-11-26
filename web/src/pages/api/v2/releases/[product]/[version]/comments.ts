import type { APIRoute } from 'astro';
import { postComment } from '../../../../../../lib/community-actions.ts';
import { community } from '../../../../../../lib/community.ts';
import { addressOf, answer, jsonWrite, outcomeResponse, publicComment, releaseOf } from '../../../../../../lib/community-http.ts';

// GET: the release's likes, reactions and shown comments (public). POST {body, parentId?}: a comment
// or a one-level reply, under the limits in lib/site/social.ts.
export const GET: APIRoute = async ({ params }) => {
  const found = await releaseOf(params);
  if (!found) return answer(404, { error: 'not_found', message: 'No such release.' });
  const social = community().store.releaseSocial(found.key, null);
  return answer(200, {
    release: found.key,
    likes: social.likes,
    reactions: social.reactions.map(({ emoji, count }) => ({ emoji, count })),
    commentCount: social.commentCount,
    comments: social.comments.map(publicComment),
  }, { 'cache-control': 'public, max-age=30', 'access-control-allow-origin': '*' });
};

export const POST: APIRoute = async context => {
  const found = await releaseOf(context.params);
  if (!found) return answer(404, { error: 'not_found', message: 'No such release.' });
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(postComment(checked.user, found.key, checked.body.body, checked.body.parentId ?? null, addressOf(context)));
};
