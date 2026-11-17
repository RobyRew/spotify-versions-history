# Ledger

The archive's source of truth: one JSON file per release, written by this repository's sensors, with git history as the audit trail.

| Path | Contents |
|---|---|
| `desktop/<major.minor>/<fullVersion>.json` | One desktop version: its Windows, Microsoft Store, macOS and Linux artifacts |
| `android/…`, `ios/…` | The mobile products, in the same shape |
| `sensors/*.json` | Each sensor's last reading: permanent-URL ETags, update-service offers, upstream catalog metadata, store listings |
| `schema/release.schema.json` | JSON Schema of a release file, generated from `lib/ledger/schema.ts` with `npm run ledger:schema` |

An artifact is one file format of one build for one platform and architecture; its id is
`<fullVersion>-<platform>-<arch>-<format>`. Each artifact keeps two kinds of evidence apart:

| Field | Written by | Contents |
|---|---|---|
| `listing` | the upstream-catalog sensor | What LoadSpot, the archived LoaderSpot table or Spotify's apt index said about the build: date, size, download links |
| `captures[]` | this repository's sensors | Each download by our CI: SHA-256, SHA-1, size, the URL and ETag it came from, the sensors that saw it, and Spotify's `binary_hash` when the update service offered the build |

The API, the site and the v1 feeds are derived from these files; nothing derived is written back.
Files are written with a fixed key order (`lib/ledger/order.ts`), so a sensor run that learns nothing
new produces no diff.

`api/v1/catalog.json` and `api/v1/windows-x64.json` are generated from the ledger by `lib/v1/feeds.ts`;
`test/v1-golden.test.ts` compares them byte for byte with what the v1 generator produced. See
`docs/adr/0001-ledger-v2.md`.
