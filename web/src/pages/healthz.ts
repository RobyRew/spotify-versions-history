import type { APIRoute } from 'astro';

// GET /healthz: answers while the process serves requests (the host's site probe reads it).
export const GET: APIRoute = () => new Response('ok\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
