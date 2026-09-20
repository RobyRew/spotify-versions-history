# Spotify versions history

A searchable catalog of Spotify desktop installers for Windows, macOS and Linux, and the watcher that keeps it current.

[**Browse the library**](https://robyrew.github.io/spotify-versions-history/) · [JSON catalog](https://robyrew.github.io/spotify-versions-history/api/v1/catalog.json) · [Windows x64 feed](https://robyrew.github.io/spotify-versions-history/api/v1/windows-x64.json)

Every build carries the source it came from — Spotify's own servers, an archived CI copy, or a community mirror — and, where the watcher saw it, the SHA-256 it computed from Spotify's own file.

## APIs

| Endpoint | Contents |
|---|---|
| [`api/v1/catalog.json`](https://robyrew.github.io/spotify-versions-history/api/v1/catalog.json) | Full normalized catalog: every platform and architecture, download origins, hashes, and the watcher's ETags |
| [`api/v1/windows-x64.json`](https://robyrew.github.io/spotify-versions-history/api/v1/windows-x64.json) | Compact Windows x64 feed: `url` is the stable mirror link, `official` Spotify's own link, plus `etag`, `archive` and `sha256` where known |

These are static files on GitHub Pages, so anything can read them. [BlockTheSpot Installer](https://github.com/RobyRew/BlockTheSpot-Installer) uses the Windows feed to offer any Spotify build.

## How it stays current

Two independent sensors, described in full in [docs/SPOTIFY_DOWNLOADS.md](docs/SPOTIFY_DOWNLOADS.md):

1. **Permanent URLs, no account.** Spotify publishes one permanent installer URL per platform that always serves the current build. A changed `ETag` means a new release: the file is downloaded from Spotify with `If-Match`, and its PE `ProductVersion`, SHA-256 and SHA-1 are read out of the bytes.
2. **The desktop update service, optional.** With a stored Spotify session, `site/scripts/probe-update-service.py` asks `desktop-update/v2/update` what Spotify offers each platform and returns the version, Spotify's own link and its `binary_hash`. Records from both sensors merge by hash, so a build seen by both is marked verified when Spotify's hash matches the downloaded file.

The catalog itself merges the maintained [LoadSpot table](https://github.com/LoaderSpot/table), its archived predecessor, and Spotify's Linux apt repository. A refresh that comes back incomplete keeps the last published snapshot rather than publishing a truncated one.

Spotify hands out versioned installer links only to signed-in clients, as signed URLs that expire; the client itself never builds them. That is why older official links answer HTTP 403 and why mirrors exist. The reasoning and the evidence are in the doc above.

## Working on it

```sh
npm ci --prefix site
npm run build --prefix site
node --test scripts/test-site.mjs
node site/scripts/update-catalog.mjs      # refresh the catalog snapshot
node site/scripts/watch-official.mjs      # check Spotify's permanent URLs
```

| Workflow | Trigger | Result |
|---|---|---|
| Version catalog | `site/**` changes, every 6 hours, or manually | Build and test the site; refresh the catalog and deploy only when the data changed |
| Watch Spotify releases | Every 30 minutes, or manually | Check Spotify's permanent URLs, record new builds with their hashes, optionally archive the installer |

Set the `SPOTIFY_ARCHIVE_TAG` repository variable to attach captured installers to a release, and the `SPOTIFY_CREDENTIALS` secret (a librespot `credentials.json`) to enable the second sensor. Without them the first sensor runs alone.

Not affiliated with Spotify.
