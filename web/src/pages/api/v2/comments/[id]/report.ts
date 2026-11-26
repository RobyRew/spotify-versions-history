import type { APIRoute } from 'astro';
import { reportComment } from '../../../../../lib/community-actions.ts';
import { addressOf, jsonWrite, outcomeResponse } from '../../../../../lib/community-http.ts';

// POST {reason}: one report per person; three since the last review hide the comment.
export const POST: APIRoute = async context => {
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(reportComment(checked.user, context.params.id, checked.body.reason, addressOf(context)));
};
