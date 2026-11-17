# ADR 0001 — Ledger v2 in git as the archive's source of truth

Date: 2026-11-17 · Status: accepted

## Context

v1 keeps three files in `site/data`:
- `catalog.json`: the merged LoadSpot table, the archived LoaderSpot table and Spotify's apt index.
- `official.json`: the release watcher's captures and readings.
- `mobile.json`: the iTunes and Microsoft Store readings.

The Pages build overlays `official.json` on the catalog and publishes two files that outside apps read:

| File | Read by |
|---|---|
| `api/v1/windows-x64.json` | BlockTheSpot-Installer |
| `api/v1/catalog.json` | Make It Play |

The archive is being rebuilt to cover every platform, with comments, likes and reactions on a VPS app. That needs one record per release that sensors, the API and the site all share, and a history anyone can audit.

## Decision

- **One file per release.** Each release is a JSON file at `ledger/<product>/<major.minor>/<fullVersion>.json`.
  - It is validated by zod in `lib/ledger/schema.ts`; the JSON Schema is generated from that definition.
  - It is written in a fixed key order (`lib/ledger/order.ts`).
- **Evidence is kept apart and never merged.**
  - An artifact's `listing` is what an upstream catalog said.
  - Its `captures` are what this repository's CI downloaded and hashed.
  - Derived views (API, site, feeds) are never written back.
- **Sensor readings** live in `ledger/sensors/*.json`: permanent-URL ETags, update-service offers, upstream catalog metadata and store listings.
- **The v1 files are generated from the ledger** by `lib/v1/feeds.ts`.
  - It uses a TypeScript port of the v1 overlay code (`lib/v1/catalog.ts`, `lib/v1/sources.ts`) with its behaviour unchanged.
  - `test/v1-golden.test.ts` compares the output byte for byte with fixtures written by the v1 generator, at two clock values.
  - From here on, v1 changes may only add fields or entries.
- **Signed `upgrade.scdn.co` links may be committed.**
  - The `fauth` JWTs recorded in `official.json` carry only `iss`, `nbf`, `exp` and `path` (decoded on 2026-11-17).
  - A sensor decodes each new token and keeps the link out of git if any other claim appears.

## Transition

1. `site/` (the v1 site, watcher and Pages build) keeps running unchanged until the sensors write the ledger.
2. That cutover change does three things:
   - runs `scripts/migrate-v2.ts` on the then-current `site/data`;
   - runs `scripts/legacy/check-v1-equivalence.mjs`, which compares both generators on the full data;
   - switches the Pages build to `scripts/build-v1.ts`.
3. `site/data` and `scripts/legacy/` are removed afterwards. The golden fixtures in `testdata/v1` stay.

## Consequences

- One sensor run that finds nothing new leaves the tree unchanged, so commits only appear for real observations.
- A fork gets the whole archive and its history without any server.
- The ledger refuses v1 data it could not represent exactly: `fromLegacy` throws instead of dropping a field.
