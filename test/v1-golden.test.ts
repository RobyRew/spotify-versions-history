// api/v1/catalog.json (Make It Play) and api/v1/windows-x64.json (BlockTheSpot-Installer) generated
// from ledger v2, compared byte for byte with what the v1 generator wrote for the same data and clock
// (testdata/v1/expected, made by scripts/legacy/make-v1-golden.mjs).
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readLedger } from '../lib/ledger/io.ts';
import { fromLegacy } from '../lib/ledger/legacy.ts';
import { buildV1 } from '../lib/v1/feeds.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const text = (path: string) => readFile(here(path), 'utf8');
const times: Record<string, string> = JSON.parse(await text('../testdata/v1/times.json'));
const legacy = async (name: string) => JSON.parse(await text(`../testdata/v1/legacy/${name}`));

describe('v1 files from ledger v2', () => {
  for (const [label, iso] of Object.entries(times)) {
    it(`equal the v1 generator's output with the clock at ${iso} (${label})`, async () => {
      const expected = {
        catalog: await text(`../testdata/v1/expected/${label}/catalog.json`),
        windowsX64: await text(`../testdata/v1/expected/${label}/windows-x64.json`),
      };
      const now = Date.parse(iso);
      expect(buildV1(await readLedger(here('../testdata/v1/ledger')), now)).toEqual(expected);
      const converted = fromLegacy({ catalog: await legacy('catalog.json'), official: await legacy('official.json'), mobile: await legacy('mobile.json') });
      expect(buildV1(converted, now)).toEqual(expected);
    });
  }
});
