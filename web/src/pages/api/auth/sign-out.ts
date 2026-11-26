import type { APIRoute } from 'astro';
import { community } from '../../../lib/community.ts';

const off = () => new Response('Sign-in is not configured on this server.\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// POST /api/auth/sign-out (same origin only; any other method answers 405): ends the local session
// and the Logto session.
export const ALL: APIRoute = context => community().auth?.signOut(context) ?? off();
