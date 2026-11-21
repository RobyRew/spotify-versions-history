# The archive's website

Astro (server output, `@astrojs/node`), Tailwind 4 with `@robyrew/web-config`, the `@robyrew/ui` app kit
and GSAP. It shows the ledger at the repository root: every release, its files and links, the link
health the probes record and the verification of the current builds, and serves the same data as a
JSON API.

The view of the data is `lib/site/model.ts` at the repository root (pure functions, tested by the root
`npm test`). This folder renders it; `src/lib/data.ts` loads the inputs and refreshes them in memory.

## Run it

```bash
npm ci --prefix ..        # zod and the ledger code's dependencies
npm ci
node scripts/fetch-data.mjs   # newest health.json and verification report from CI into .data/ (needs gh)
npm run dev                   # http://localhost:4355
```

`npm run check` runs `astro sync`, TypeScript 7 and Astro's checker (on TypeScript 6, see
`scripts/astro-check.mjs`); `npm run build` checks and builds; `npm run preview` serves the build.

## Inputs

| Variable | Default | What |
| --- | --- | --- |
| `LEDGER_DIR` | — | ledger files (`lib/ledger/io.ts`); used when set |
| `LEGACY_DATA_DIR` | `../site/data` | the v1 data files, converted with `fromLegacy` until the ledger files are committed |
| `HEALTH_URL` / `HEALTH_FILE` | `.data/health.json` | link health, as `sensors/health.ts` writes it |
| `VERIFICATION_URL` / `VERIFICATION_FILE` | `.data/verification.json` | the merged report `sensors/verify.ts merge` writes |
| `PUBLIC_SITE_URL` | `https://spotify-versions-history.robyrew.com` | the site's own URL, for canonical links and CSRF origin checks |

Health and verification are optional: without them every link not known to be dead is offered and
every file shows as not checked yet.

## Routes

| Route | |
| --- | --- |
| `/` | the newest build per platform (first-party links before the mirror), store listings, recent releases, probe status |
| `/versions` | every release; GET filters (`q`, `platform`, `arch`, `signed`, `live`, `sort`) and Load more |
| `/v/{product}/{version}` | one release: its files, hashes, verification, every link, permanent links, the commands to check a file by hand |
| `/probes` | the latest verification report and link health per source |
| `/api`, `/about` | the API reference and how the archive works |
| `/api/v2/…` | JSON: `releases`, `releases/{product}/{version}`, `latest[/{platform}/{arch}]`, `verification`, `health` |
| `/dl/{artifact id}` | a permanent link: 302 to the best live copy |
| `/healthz` | `ok` while the process serves requests |
