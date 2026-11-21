import type { APIRoute } from 'astro';
import { latestDownloads, releaseJson } from '../../../../../../../lib/site/model.ts';
import { json, notFound } from '../../../../../lib/api.ts';
import { siteData } from '../../../../../lib/data.ts';

// GET /api/v2/latest/{platform}/{arch}
export const GET: APIRoute = async ({ request, params }) => {
  const data = await siteData();
  const match = latestDownloads(data.releases).find(item => item.platform === params.platform && item.arch === params.arch);
  if (!match) return notFound(request, `no live ${params.platform} ${params.arch} build`);
  const full = releaseJson(match.release);
  return json(request, { platform: match.platform, arch: match.arch, version: match.release.version, fullVersion: match.release.fullVersion, date: match.release.date, artifact: full.artifacts.find(item => item.id === match.artifact.id) });
};
