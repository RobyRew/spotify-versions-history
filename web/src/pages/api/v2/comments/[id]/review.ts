import type { APIRoute } from 'astro';
import { reviewComment } from '../../../../../lib/community-actions.ts';
import { jsonWrite, outcomeResponse } from '../../../../../lib/community-http.ts';

// POST {keep: boolean}: a moderator shows a reported comment again or removes it.
export const POST: APIRoute = async context => {
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(reviewComment(checked.user, context.params.id, checked.body.keep === true));
};
