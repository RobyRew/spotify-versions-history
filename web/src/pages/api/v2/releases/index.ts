import type { APIRoute } from 'astro';
import { filterReleases, isReleaseSort, page, releaseJson, type Arch, type Platform } from '../../../../../../lib/site/model.ts';
import { releaseKey } from '../../../../../../lib/site/social.ts';
import { isPeriod } from '../../../../../../lib/site/social-store.ts';
import { json } from '../../../../lib/api.ts';
import { releaseCounts } from '../../../../lib/community.ts';
import { siteData } from '../../../../lib/data.ts';

// GET /api/v2/releases?q=&platform=&arch=&sort=newest|oldest|liked|discussed|downloads|active|trending
//   &period=day|week|month|all&commented=1&signed=1&live=1&limit=50&cursor=
// Each release carries its community counts in the period (downloads, likes, comments; downloads in
// the last seven days and the time of the last activity regardless).
export const GET: APIRoute = async ({ request, url }) => {
  const data = await siteData();
  const params = url.searchParams;
  const sort = params.get('sort');
  const periodParam = params.get('period');
  const counts = releaseCounts(isPeriod(periodParam) ? periodParam : 'all');
  const limit = Math.min(100, Math.max(1, Number.parseInt(params.get('limit') ?? '50', 10) || 50));
  const matches = filterReleases(data.releases, {
    q: (params.get('q') ?? '').slice(0, 64),
    platform: (params.get('platform') || null) as Platform | null,
    arch: (params.get('arch') || null) as Arch | null,
    sort: isReleaseSort(sort) ? sort : 'newest',
    signed: params.get('signed') === '1',
    downloadable: params.get('live') === '1',
    counts,
    commented: params.get('commented') === '1',
  });
  const { items, next } = page(matches, params.get('cursor'), limit);
  const zero = { downloads: 0, recentDownloads: 0, likes: 0, comments: 0, lastActivity: null };
  return json(request, { total: matches.length, next, releases: items.map(release => {
    const count = counts.get(releaseKey(release)) ?? zero;
    return { ...releaseJson(release), counts: { ...count, lastActivity: count.lastActivity ? new Date(count.lastActivity).toISOString() : null } };
  }) });
};
