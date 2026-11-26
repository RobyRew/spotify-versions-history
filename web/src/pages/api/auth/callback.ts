import type { APIRoute } from 'astro';
import { community } from '../../../lib/community.ts';

const off = () => new Response('Sign-in is not configured on this server.\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// GET /api/auth/callback: Logto's redirect URI for this site.
export const GET: APIRoute = context => community().auth?.callback(context) ?? off();
