import type { APIRoute } from 'astro';
import { setCommentReaction } from '../../../../../../lib/community-actions.ts';
import { addressOf, jsonWrite, outcomeResponse } from '../../../../../../lib/community-http.ts';

// PUT adds the viewer's reaction to a comment, DELETE removes it.
const write = (on: boolean): APIRoute => async context => {
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(setCommentReaction(checked.user, context.params.id, context.params.emoji, on, addressOf(context)));
};
export const PUT = write(true);
export const DELETE = write(false);
