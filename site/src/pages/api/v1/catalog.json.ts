import catalog from '../../../../data/catalog.json';
import official from '../../../../data/official.json';
import { applyOfficial } from '../../../lib/catalog.mjs';
export function GET() {
  const entries = applyOfficial(catalog.entries, official);
  return new Response(JSON.stringify({ ...catalog, official: { watched: official.watched }, entries }), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
