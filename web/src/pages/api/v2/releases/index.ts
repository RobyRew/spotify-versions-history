import type { APIRoute } from 'astro';
import { filterReleases, page, releaseJson, type Arch, type Platform } from '../../../../../../lib/site/model.ts';
import { json } from '../../../../lib/api.ts';
import { siteData } from '../../../../lib/data.ts';

// GET /api/v2/releases?q=&platform=&arch=&sort=newest|oldest&signed=1&live=1&limit=50&cursor=
export const GET: APIRoute = async ({ request, url }) => {
  const data = await siteData();
  const params = url.searchParams;
  const limit = Math.min(100, Math.max(1, Number.parseInt(params.get('limit') ?? '50', 10) || 50));
  const matches = filterReleases(data.releases, {
    q: (params.get('q') ?? '').slice(0, 64),
    platform: (params.get('platform') || null) as Platform | null,
    arch: (params.get('arch') || null) as Arch | null,
    sort: params.get('sort') === 'oldest' ? 'oldest' : 'newest',
    signed: params.get('signed') === '1',
    downloadable: params.get('live') === '1',
  });
  const { items, next } = page(matches, params.get('cursor'), limit);
  return json(request, { total: matches.length, next, releases: items.map(releaseJson) });
};
