import type { APIRoute } from 'astro';
import { siteData } from '../../lib/data.ts';

// GET|HEAD /dl/{artifact id}: the permanent link of one file, a redirect to the best live copy.
const resolve: APIRoute = async ({ params }) => {
  const data = await siteData();
  const artifact = data.releases.flatMap(release => release.artifacts).find(item => item.id === params.id);
  const headers = { 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex, nofollow' };
  if (!artifact) return new Response('No such file in the archive.\n', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  if (!artifact.best) return new Response('The archive knows this file, but no live copy of it right now.\n', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  return new Response(null, { status: 302, headers: { ...headers, location: artifact.best.url } });
};
export const GET = resolve;
export const HEAD = resolve;
