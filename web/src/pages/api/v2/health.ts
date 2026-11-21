import type { APIRoute } from 'astro';
import { json, notFound } from '../../../lib/api.ts';
import { siteData } from '../../../lib/data.ts';

// GET /api/v2/health: the last answer of every download link the ledger records.
export const GET: APIRoute = async ({ request }) => {
  const data = await siteData();
  return data.health ? json(request, data.health, { maxAge: 300 }) : notFound(request, 'no link-health file is loaded');
};
