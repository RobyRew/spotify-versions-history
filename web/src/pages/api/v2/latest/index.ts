import type { APIRoute } from 'astro';
import { latestDownloads, releaseJson } from '../../../../../../lib/site/model.ts';
import { json } from '../../../../lib/api.ts';
import { siteData } from '../../../../lib/data.ts';

// GET /api/v2/latest: the newest release of each platform and architecture with a live link.
export const GET: APIRoute = async ({ request }) => {
  const data = await siteData();
  return json(request, latestDownloads(data.releases).map(({ platform, arch, release, artifact }) => {
    const full = releaseJson(release);
    return { platform, arch, version: release.version, fullVersion: release.fullVersion, date: release.date, artifact: full.artifacts.find(item => item.id === artifact.id) };
  }));
};
