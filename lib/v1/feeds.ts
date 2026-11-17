/**
 * The two v1 JSON files on GitHub Pages, generated from ledger v2:
 *  - api/v1/catalog.json, read by Make It Play;
 *  - api/v1/windows-x64.json, read by BlockTheSpot-Installer.
 * The serialization repeats site/src/pages/api/v1/*.json.ts exactly (compact JSON, same key order).
 */
import { toLegacy } from '../ledger/legacy.ts';
import type { Ledger } from '../ledger/schema.ts';
import { applyOfficial, windowsFeed } from './catalog.ts';

export interface V1Files {
  catalog: string;
  windowsX64: string;
}

export function buildV1(ledger: Ledger, now = Date.now()): V1Files {
  const { catalog, official } = toLegacy(ledger);
  const entries = applyOfficial(catalog.entries, official, now);
  return {
    catalog: JSON.stringify({ ...catalog, official: { watched: official.watched }, entries }),
    windowsX64: JSON.stringify(windowsFeed(entries)),
  };
}
