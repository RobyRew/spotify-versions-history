import type { APIRoute } from 'astro';
import { community } from '../../../lib/community.ts';

// POST /api/hooks/logto: the site's Logto webhook, HMAC-checked by astro-logto. Profile changes update
// the stored handle, name and picture; suspension and deletion end the person's sessions, and a
// deleted account's comments lose their name.
export const POST: APIRoute = ({ request }) => {
  const { webhook } = community();
  return webhook ? webhook(request) : new Response('Not configured.\n', { status: 404 });
};
