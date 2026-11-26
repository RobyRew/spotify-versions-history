import type { APIRoute } from 'astro';
import { setLike } from '../../../../../../lib/community-actions.ts';
import { addressOf, answer, jsonWrite, outcomeResponse, releaseOf } from '../../../../../../lib/community-http.ts';

// PUT likes the release, DELETE takes the like back. Signed in, same origin, JSON.
const write = (liked: boolean): APIRoute => async context => {
  const found = await releaseOf(context.params);
  if (!found) return answer(404, { error: 'not_found', message: 'No such release.' });
  const checked = await jsonWrite(context);
  if (checked instanceof Response) return checked;
  return outcomeResponse(setLike(checked.user, found.key, liked, addressOf(context)));
};
export const PUT = write(true);
export const DELETE = write(false);
