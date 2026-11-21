import type { APIRoute } from 'astro';
import { json, notFound } from '../../../lib/api.ts';
import { siteData } from '../../../lib/data.ts';

// GET /api/v2/verification: the latest merged verification report of the current builds.
export const GET: APIRoute = async ({ request }) => {
  const data = await siteData();
  return data.verification ? json(request, data.verification, { maxAge: 300 }) : notFound(request, 'no verification report is loaded');
};
