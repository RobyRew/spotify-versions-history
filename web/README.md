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
npm run dev                   # http://localhost:4355, read-only (no sign-in)
npm run dev:local             # the same with sign-in against a fake Logto: pick a seeded person
```

`dev:local` (`scripts/dev-local.mjs`) starts `@robyrew/astro-logto/testing` on 127.0.0.1:4356 with six
seeded people (`mira` has the `moderator` role, `carol` has no handle yet) and keeps its data in
`./data/dev`. It signs in anyone who asks: never deploy it.

`npm run check` runs `astro sync`, TypeScript 7 and Astro's checker (on TypeScript 6, see
`scripts/astro-check.mjs`); `npm run build` checks and builds; `npm run preview` serves the build.

## Inputs

| Variable | Default | What |
| --- | --- | --- |
| `LEDGER_DIR` | — | ledger files (`lib/ledger/io.ts`); used when set |
| `LEGACY_DATA_URL` | — | a base URL for the v1 data files (`catalog.json`, `official.json`, `mobile.json`); tried first, refreshed every ten minutes |
| `LEGACY_DATA_DIR` | `../site/data` | the v1 data files, converted with `fromLegacy` until the ledger files are committed; the fallback when `LEGACY_DATA_URL` cannot be read at start |
| `HEALTH_URL` / `HEALTH_FILE` | `.data/health.json` | link health, as `sensors/health.ts` writes it |
| `VERIFICATION_URL` / `VERIFICATION_FILE` | `.data/verification.json` | the merged report `sensors/verify.ts merge` writes |
| `PUBLIC_SITE_URL` | `https://spotify-versions-history.robyrew.com` | the site's own URL, for canonical links and CSRF origin checks |

Health and verification are optional: without them every link not known to be dead is offered and
every file shows as not checked yet.

Sign-in and the community data (`src/lib/community.ts`):

| Variable | Default | What |
| --- | --- | --- |
| `DATA_DIR` | `./data` | `archive.db`: people who signed in, likes, reactions, comments, reports, daily download counts, sealed sessions. A volume in production |
| `LOGTO_ENDPOINT` | — | `https://auth.robyrew.com`; with the next three, turns sign-in on |
| `LOGTO_APP_ID` / `LOGTO_APP_SECRET` | — | the site's first-party Traditional Web app (redirect `/api/auth/callback`, post sign-out `/`, ID-token roles on) |
| `LOGTO_COOKIE_SECRET` | — | at least 32 characters (`openssl rand -base64 32`); changing it signs everyone out |
| `LOGTO_WEBHOOK_SIGNING_KEY` | — | the site's Logto webhook at `/api/hooks/logto` (User.Data.Updated, User.SuspensionStatus.Updated, User.Deleted) |
| `AVATAR_ORIGINS` | `https://id.robyrew.com` | origins avatars load from; also read at build time for the CSP |
| `ID_SITE_URL` | `https://id.robyrew.com` | where people manage their handle |

Without the four `LOGTO_*` sign-in variables the site is read-only: counts and comments show, nothing
offers to sign in. `LOGTO_ENDPOINT` is also read at build time: the CSP's `form-action` lists it,
because sign-out answers with a redirect to Logto.

The rules (comment text and links, limits, report threshold, download dedupe) are in
`lib/site/social.ts`; the queries in `lib/site/social-store.ts`; both are tested by the root `npm test`.

## Production

`web/Dockerfile` (build context: the repository root) makes a non-root `node:26-alpine` image that
runs the standalone server on port 4321 with `HEALTHCHECK NONE` (the host's probe calls `/healthz`).
CI's `image` job builds it after the tests and pushes `ghcr.io/robyrew/spotify-versions-history`
(`latest` and the commit SHA) when the site's inputs changed, then calls the repository secret
`DOKPLOY_DEPLOY_WEBHOOK` so Dokploy pulls it. Dokploy runs it as the application
`spotify-versions-history` (Tools project) at https://spotify-versions-history.robyrew.com, with:

- the named volume `spotify-versions-history-data` at `/app/data` (`archive.db`, and
  `snapshot/archive.db`, the copy to restore from);
- a 192 MiB memory limit (the image caps the heap at 128 MB);
- `LEGACY_DATA_URL=https://raw.githubusercontent.com/RobyRew/spotify-versions-history/main/site/data/`,
  `HEALTH_URL=https://robyrew.github.io/spotify-versions-history/data/health.json` and
  `VERIFICATION_URL=https://robyrew.github.io/spotify-versions-history/data/verification.json`: the
  release watcher's commits, and the files the Pages build publishes from the newest health and
  verify runs (both workflows ask Pages to republish when they finish);
- the `LOGTO_*` variables above once the site's Logto app exists.

## Routes

| Route | |
| --- | --- |
| `/` | the newest build per platform (first-party links before the mirror), store listings, recent releases, probe status |
| `/versions` | every release; GET filters (`q`, `platform`, `arch`, `signed`, `live`, `sort`: newest, oldest, downloads, trending, liked, discussed) and Load more |
| `/v/{product}/{version}` | one release: its files, hashes, verification, every link, permanent links, the commands to check a file by hand, likes, reactions and comments |
| `/probes` | the latest verification report and link health per source |
| `/api`, `/about` | the API reference and how the archive works |
| `/api/v2/…` | JSON: `releases`, `releases/{product}/{version}`, `latest[/{platform}/{arch}]`, `verification`, `health` |
| `/dl/{artifact id}` | a permanent link: 302 to the best live copy; a browser GET counts one download per visitor, file and day |
| `/api/auth/sign-in`, `/callback`, `/sign-out` | Logto sign-in (scopes `profile offline_access roles`, no e-mail); sign-out is a same-origin POST |
| `/v/{product}/{version}/act` | the release page's form endpoint (like, react, comment, reply, edit, delete, report, review); JSON with `Accept: application/json` |
| `/api/v2/releases/{product}/{version}/comments` | GET likes, reactions and shown comments; POST `{body, parentId?}` |
| `/api/v2/releases/{…}/like`, `/reactions/{emoji}`, `/api/v2/comments/{id}[/reactions/{emoji}\|/report\|/review]` | signed-in JSON writes; same origin and `application/json` only |
| `/admin` | reported comments, for the Logto role `moderator` |
| `/api/hooks/logto` | the HMAC-checked Logto webhook |
| `/healthz` | `ok` while the process serves requests |
