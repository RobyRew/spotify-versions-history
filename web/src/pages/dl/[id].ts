import type { APIRoute } from 'astro';
import { isBot, releaseKey, subnetOf, visitorKey } from '../../../../lib/site/social.ts';
import { community } from '../../lib/community.ts';
import { addressOf } from '../../lib/community-http.ts';
import { siteData } from '../../lib/data.ts';

// GET|HEAD /dl/{artifact id}: the permanent link of one file, a redirect to the best live copy. A GET
// from a browser counts one download per visitor, file and day (lib/site/social.ts); HEAD and bots
// are not counted, and a failed count never stops the redirect.
const resolve: APIRoute = async context => {
  const { params, request } = context;
  const data = await siteData();
  const release = data.releases.find(item => item.artifacts.some(artifact => artifact.id === params.id));
  const artifact = release?.artifacts.find(item => item.id === params.id);
  const headers = { 'cache-control': 'public, max-age=300', 'x-robots-tag': 'noindex, nofollow' };
  if (!artifact) return new Response('No such file in the archive.\n', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  if (!artifact.best) return new Response('The archive knows this file, but no live copy of it right now.\n', { status: 404, headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' } });
  const agent = request.headers.get('user-agent');
  if (request.method === 'GET' && release && !isBot(agent)) {
    try {
      const { store } = community();
      const address = addressOf(context);
      store.recordDownload({ artifact: artifact.id, release: releaseKey(release), visitor: visitorKey(store.dailySalt(), address, agent ?? ''), subnet: subnetOf(address) });
    } catch (error) {
      console.error('download count failed', error);
    }
  }
  // Not cached by browsers or proxies, so every visit reaches the count.
  return new Response(null, { status: 302, headers: { ...headers, 'cache-control': 'no-store', location: artifact.best.url } });
};
export const GET = resolve;
export const HEAD = resolve;
