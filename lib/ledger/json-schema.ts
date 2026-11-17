/** JSON Schema (draft 2020-12) of a ledger release file, generated from the zod definition in schema.ts. */
import { z } from 'zod';
import { Release } from './schema.ts';

export const RELEASE_SCHEMA_PATH = 'ledger/schema/release.schema.json';

export function releaseJsonSchema(): string {
  const schema = z.toJSONSchema(Release, { target: 'draft-2020-12', io: 'input' });
  return JSON.stringify({
    ...schema,
    $id: 'https://github.com/RobyRew/spotify-versions-history/blob/main/ledger/schema/release.schema.json',
    title: 'Spotify versions archive: one release',
    description: 'A release and its artifacts. `listing` is what an upstream catalog said; `captures` is what this repository downloaded and hashed. Cross-field rules (artifact ids, version agreement) are enforced by lib/ledger/schema.ts.',
  }, null, 2) + '\n';
}
