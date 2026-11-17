/** Regenerates ledger/schema/release.schema.json from lib/ledger/schema.ts: node scripts/gen-schema.ts */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RELEASE_SCHEMA_PATH, releaseJsonSchema } from '../lib/ledger/json-schema.ts';

await mkdir(dirname(RELEASE_SCHEMA_PATH), { recursive: true });
await writeFile(RELEASE_SCHEMA_PATH, releaseJsonSchema());
console.log(`Wrote ${RELEASE_SCHEMA_PATH}`);
