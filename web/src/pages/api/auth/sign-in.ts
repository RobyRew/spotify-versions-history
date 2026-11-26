import type { APIRoute } from 'astro';
import { community } from '../../../lib/community.ts';

const off = () => new Response('Sign-in is not configured on this server.\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// GET /api/auth/sign-in?returnTo=/path: to Logto, and back to that path (local paths only).
export const GET: APIRoute = context => community().auth?.signIn(context) ?? off();
