import type { APIRoute } from 'astro';
import { setReaction } from '../../../../../../../lib/community-actions.ts';
import { addressOf, answer, jsonWrite, outcomeResponse, releaseOf } from '../../../../../../../lib/community-http.ts';

// PUT adds the viewer's reaction (one of the six quick emoji, URL-encoded), DELETE removes it.
const write = (on: boolean): APIRoute => async context => {
  const found = await releaseOf(context.params);
  if (!found) return answer(404, { error: 'not_found', message: 'No such release.' });
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(setReaction(checked.user, found.key, context.params.emoji, on, addressOf(context)));
};
export const PUT = write(true);
export const DELETE = write(false);
