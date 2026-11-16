# Deploy

The public site is `https://spotify-versions-history.robyrew.com`. GitHub Pages keeps publishing the same static catalog, because Make It Play reads `https://robyrew.github.io/spotify-versions-history/api/v1/catalog.json`.

## What runs where

- The VPS container serves the Astro build and the write API. Metadata is SQLite at `ARCHIVE_DB` (default `/data/archive.sqlite`). Put that file on a volume and add it to the restic job that already ships to Backblaze.
- Installer bytes do not go on the VPS disk. A new copy is uploaded to the B2 bucket `spotify-versions` only when `needsOwnMirror` is true: Spotify is no longer serving the build (or the signed link is inside three days of expiry) and `loadspot.amd64fox1.workers.dev` is not HTTP 200. The object key is `sha256/<hash>/<stable filename>`. Cloudflare caches `https://dl.spotify-versions-history.robyrew.com` with a long immutable lifetime. The application key can write only that bucket, and it lives in GitHub Actions, not in the web container.
- `GET /r/<version>/<platform>/<architecture>` is the permanent link. It 302s to whichever of Spotify, the B2 object, or amd64fox `selectSource` currently prefers, and counts the hop.

## Dokploy

Build context is the repository root. Dockerfile: `site/Dockerfile`.

```
PUBLIC_SITE_URL=https://spotify-versions-history.robyrew.com
LOGTO_ENDPOINT=https://auth.robyrew.com
LOGTO_APP_ID=
LOGTO_APP_SECRET=
ARCHIVE_DB=/data/archive.sqlite
ARCHIVE_INGEST_TOKEN=
```

Logto application type: Traditional Web. Redirect `https://spotify-versions-history.robyrew.com/api/auth/callback`. Post sign-out `https://spotify-versions-history.robyrew.com/`. The session cookie is an opaque id (`__Host-sv_sid` on https). Tokens sit in the `logto_sessions` table. `@robyrew/astro-logto` 0.1.0 does not encrypt that cookie, so `LOGTO_COOKIE_SECRET` is not read.

`@robyrew/astro-logto` is `git+https://github.com/RobyRew/astro-logto.git#v0.1.0`. Without `LOGTO_ENDPOINT`, `LOGTO_APP_ID` and `LOGTO_APP_SECRET` the process still boots and sign-in answers 503. The recipe for the claim and the redirect is in `infrastructure/docs/logto-app-integration.md`.

The API resource, for a bearer client, is `https://spotify-versions-history.robyrew.com/api`. A username claim named `username` (`[a-z0-9_]{3,20}`) is copied onto the local user. Role `archive-admin` in the `roles` claim may delete any comment.

`ARCHIVE_INGEST_TOKEN` is the bearer the watcher sends as `POST /api/v1/ingest`. Without `ARCHIVE_INGEST_URL` the watcher still writes `official.json` and Pages keeps updating.

## DNS

- `spotify-versions-history.robyrew.com` → the Dokploy router.
- `dl.spotify-versions-history.robyrew.com` → the B2 bucket, orange-clouded, cache everything. The HTML app stays on the first host.

## Site probe

Add `https://spotify-versions-history.robyrew.com` to `dokploy_site_probe_sites`. The health check does not call Logto.
