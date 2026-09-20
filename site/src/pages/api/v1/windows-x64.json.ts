import catalog from '../../../../data/catalog.json';
import official from '../../../../data/official.json';
import { applyOfficial, windowsFeed } from '../../../lib/catalog.mjs';
export function GET() {
  return new Response(JSON.stringify(windowsFeed(applyOfficial(catalog.entries, official))), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
