import type { APIRoute } from 'astro';
import { findRelease, releaseJson } from '../../../../../../../lib/site/model.ts';
import { json, notFound } from '../../../../../lib/api.ts';
import { siteData } from '../../../../../lib/data.ts';

// GET /api/v2/releases/{product}/{version}: the numeric version or the full build id.
export const GET: APIRoute = async ({ request, params }) => {
  const data = await siteData();
  const release = findRelease(data.releases, params.product ?? '', params.version ?? '');
  return release ? json(request, releaseJson(release)) : notFound(request, `no ${params.product} release ${params.version}`);
};
