import type { APIRoute } from 'astro';
import { deleteComment, editComment } from '../../../../lib/community-actions.ts';
import { addressOf, jsonWrite, outcomeResponse } from '../../../../lib/community-http.ts';

// PATCH {body} edits, DELETE deletes: the author within 15 minutes, a moderator at any time.
export const PATCH: APIRoute = async context => {
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(editComment(checked.user, context.params.id, checked.body.body, addressOf(context)));
};

export const DELETE: APIRoute = async context => {
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(deleteComment(checked.user, context.params.id));
};
