# Where Spotify installers come from

Findings from probing Spotify's distribution on 2026-09-17, recorded so the download policy in
`src/BlockTheSpot.Core/Catalog.cs` and `InstallerService.cs` can be re-checked instead of trusted.

## Spotify publishes exactly one permanent installer URL per platform

| URL | Serves |
|---|---|
| `https://download.scdn.co/SpotifyFullSetupX64.exe` | current Windows x64 full installer (also `SpotifyFullSetup.exe` for x86) |
| `https://download.scdn.co/Spotify.dmg`, `SpotifyARM64.dmg` | current macOS builds |
| `https://repository.spotify.com/pool/non-free/s/spotify-client/…` | Linux `.deb` packages, versioned, listed in the apt `Packages` index |

These links are unsigned, stable and always point at the newest build. On 2026-09-17 the x64 EXE
answered `200`, `Content-Length: 148153000`, `Last-Modified: Thu, 17 Sep 2026 15:26:53 GMT`. The
app exposes this as **Latest official Spotify**.

Three more observations (2026-09-18) shape the release watcher below:

- All permanent URLs (`SpotifyFullSetupX64.exe`, `SpotifyFullSetupARM64.exe`, `SpotifySetup.exe`,
  both DMGs) rotated within the same minute, 15:26 UTC on 2026-09-17, i.e. at the moment the
  update service started offering 1.3.1.234. `SpotifyFullSetup.exe` (x86) has not moved since
  2026-02-22 and still serves 1.2.53.440; Spotify stopped shipping x86 there.
- The file behind `SpotifyFullSetupX64.exe` is byte-identical to the upgrade package the update
  service hands out for the same build: the LoadSpot copy `spotify_installer-1.3.1.234.g59d6bf59-x64.exe`
  and the permanent URL both hashed to SHA-256 `6c25d92dd38ddbfc1e4970765e865766d8ae2ef1758c6af8e9122c5050ee66dc`
  (ProductVersion `1.3.1.234.g59d6bf59`, Authenticode `O=Spotify AB`). "Full setup" and "upgrade
  installer" are one file.
- The permanent URLs are S3-backed (`x-amz-checksum-crc32c`, `ETag`) and honour `If-Match`: a
  stale ETag answers `412 Precondition Failed`, a current one `200`/`206`. A download can therefore be
  pinned to the build it was catalogued as, without any authentication.

## Versioned Windows installers are handed out by the client update service, signed and short-lived

The desktop client does not poll a public list. It calls

```
GET https://spclient.wg.spotify.com/desktop-update/v2/update?client_version=<version>&ct=S
Authorization: Bearer <access token of a logged-in session>
Spotify-App-Version: <version the client claims to run>
App-Platform: Win32_x86_64 | Win32_ARM64 | OSX | OSX_ARM64
```

and receives a protobuf `UpdateQueryResponse` (`protocol/proto/client_update.proto` in librespot,
extracted from Spotify 1.2.52): `poll_interval` plus, when an upgrade applies, an
`UpgradeRequiredMessage { upgrade_signed_part, signature, http_suffix }`. The download URL is
`UpgradeSignedPart.http_prefix + http_suffix`, i.e.

```
https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-<full version>-<n>.exe?fauth=<token>
```

Consequences observed:

- The service only ever returns the *current* build for the claimed platform, never an archive.
  A specific older version cannot be requested from Spotify.
- The `?fauth=` query is a Fastly-style signed token. Without it `upgrade.scdn.co` answers
  `403 Forbidden` (Varnish error 54113) for every path, including paths that never existed.
  Sixteen historical `upgrade.scdn.co` links sampled from the catalog, from 1.2.9.741 up to
  1.2.85.519 (published 2026-03), all answered `403`; the same paths on `download.scdn.co` and
  `download.spotify.com` answered `404`.
- The trailing `-<n>` is not derivable from the version; older tooling (SpotifyUpgradeFinder)
  brute-forced it while the bucket was still public, which it no longer is.
- Community catalogs obtain new links from inside a logged-in client: SpotX's `checkVersion.js`
  calls the endpoint above with the captured bearer token for each platform and reports the
  resulting `upgrade.scdn.co…?fauth=` link to LoadSpot's ingest worker, which stores a copy behind
  `https://loadspot.amd64fox1.workers.dev/download/spotify_installer-<full version>-x64.exe`
  (Cloudflare, `200`, no redirect, `content-disposition` with the stable filename).

## The release watcher: two sensors, one record per build

`site/scripts/watch-official.mjs` runs every 30 minutes from `.github/workflows/watch-spotify.yml`
(Spotify's own clients poll every ~4 h, `poll_interval` 14288 s in the capture) and keeps
`site/data/official.json`, which the Pages build overlays on the catalog (`applyOfficial`).

1. **Permanent-URL sensor, no account.** `HEAD` on the six URLs above; a changed `ETag` on a
   Windows EXE means a new build. The file is downloaded from Spotify with `If-Match`, its PE
   `ProductVersion`, machine type, SHA-256 and SHA-1 are read from the bytes, and the build is
   recorded with the ETag, size and `Last-Modified`. When the `SPOTIFY_ARCHIVE_TAG` repository
   variable is set (or the workflow input is ticked), the file is attached to that GitHub release as
   `spotify_installer-<version>-<arch>.exe`, so older builds keep a copy that this repository's CI
   took from Spotify, with its hash logged in the run and in `official.json`.
2. **Update-service sensor, optional.** `site/scripts/probe-update-service.py` asks
   `desktop-update/v2/update` for each platform the way the client does, using a stored Spotify
   session (librespot-python, OAuth once: `python3 site/scripts/probe-update-service.py --login`,
   then the `credentials.json` goes into the `SPOTIFY_CREDENTIALS` secret). It decodes the
   protobuf without a dependency and reports the offered version, `http_prefix`, the signed URL and
   Spotify's own `binary_hash`. Without the secret the step is skipped and sensor 1 works alone.
3. **Reconciliation.** Records are keyed by SHA-256, so a build seen by both sensors is one record
   with `sensors: ["permanent-url", "update-service"]`. A build gets `verified: "binary_hash"` when
   Spotify's hash equals the SHA-256 or SHA-1 of the downloaded file, and `conflict` when it matches
   neither — a conflict is printed in the run and never marks the build verified. A build the service
   offers but the permanent URL has not shown yet is downloaded from the signed link while it is
   valid and recorded with `sensors: ["update-service"]`.

Live run on 2026-09-18 with a stored session (claiming version 1.2.0.0), which settled the unknowns:

- The service accepted the librespot session (keymaster token for the desktop client id plus a
  client-token) and answered `200` with protobuf for all four platforms.
- `binary_hash` is the **SHA-1** of the installer: `fdfc152db2f4249c72d944d75310c310b8d84974` for
  1.3.1.234 x64 and `218b9985e87aeea4b9112ef37d6c9df661c650be` for ARM64, both equal to the SHA-1 the
  permanent-URL sensor had computed the day before from `download.scdn.co`. Both builds are recorded
  as `verified`.
- `http_prefix` was `…/spotify_installer-1.3.1.234.g59d6bf59-5377.exe`; the `-5377` build number is
  shared across platforms. `http_suffix` is `?fauth=<JWT>` signed by `scdn-url-signer` with
  `nbf`/`exp` 30 days apart and the path bound in the claim, so a signed link is usable for a month.
- `OSX` (Intel) answered "up to date" for the 1.2.0.0 claim while `OSX_ARM64` was offered 1.3.1.234;
  Spotify no longer pushes Intel macOS upgrades to old versions through this channel.
- `poll_interval` varied between 11258 s and 14669 s across platforms (about 3–4 h, jittered).

What the catalog and the app get from this: `sha256` per observed build, the permanent URL with
its ETag while the build is current, the signed link while its token lasts, the archive copy when
one exists, and Spotify's `http_prefix`.

### The official-link record

Every build keeps Spotify's own address on its row for good, downloadable or not. Sources are
ordered Spotify first (permanent URL while current → signed link while valid → apt repository),
then the CI archive copy, then the LoadSpot mirror; expired official links sort last, are never the
download button, and are rendered as the bare path so the record stays visible and copyable.

Coverage of that record, checked 2026-09-18 against the git history of `LoaderSpot/table`
(474 revisions of `versions.json` since 2025-02) and the archived `LoaderSpot/LoaderSpot`:

- 1.2.7.1277 → 1.2.85.519: Spotify's `upgrade.scdn.co` paths for every release build, already in
  the catalog from the legacy feed. The history holds 71 more x64 links, all `buildType: Master`
  (internal-channel builds LoadSpot later removed), excluded from the catalog by design.
- 1.2.86 → 1.3.1.223 (2026-03 to 2026-09): no public record exists. LoadSpot switched to mirror-only
  entries between 2026-01-13 (224 official links) and 2026-04-05 (none), and the `-<n>` build number
  cannot be reconstructed. This includes the tested build 1.2.93.667.
- 1.3.1.234 onward: the update-service sensor records `http_prefix` and the signed link for each
  build as it is released.

## What the installer does with this

1. **Latest official Spotify** downloads straight from `download.scdn.co`.
2. A versioned build is tried in this order: Spotify's permanent URL with `If-Match` on the ETag the
   watcher recorded (only while that build is current; 412 once it rotates), else Spotify's
   `upgrade.scdn.co` link when one was ever published (403 once expired), then the CI archive copy,
   then the LoadSpot filename. A failed request moves on and is logged as *Switching source*; a
   SHA-256, size or executable mismatch does not fall back.
3. A typed full version (`1.2.80.699.gd5f6ebe3`) or a link on either host becomes a choice through
   `SpotifyVersions.TryCustom`; a link on any other host is rejected.
4. When the feed carries a `sha256` (every build the watcher observed, plus the pinned tested build),
   the whole download is hashed and a mismatch is rejected before anything runs. Every setup must
   then carry a valid Authenticode signature from `O=Spotify AB` or `O=Spotify USA Inc.`
   (`WindowsSpotifyPlatform.VerifySpotifyPublisherAsync`), and the installed version must equal the
   selected one afterwards. Those checks, not the hostname, tie a mirror or archive download to
   Spotify's own bytes.

Re-check with:

```sh
curl -sI https://download.scdn.co/SpotifyFullSetupX64.exe | head -5
curl -sI https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.2.85.519.g549a528b-4062.exe | head -1
curl -sI https://loadspot.amd64fox1.workers.dev/download/spotify_installer-1.2.93.667.g7b5cc0ce-x64.exe | head -1
```

A signed link is only ever obtained by the watcher's optional second sensor in CI; the installer
itself never holds a Spotify session.

## Certificate roots the installer carries

Reported 2026-09-18 from a Windows PC: `The SSL connection could not be established … UntrustedRoot`
on the first `github.com` request, while the `*.github.io` catalog had loaded. Chains observed that day:

| Host | Chain root |
|---|---|
| `github.com`, `api.github.com` | Sectigo Public Server Authentication Root E46 (cross-signed by USERTrust ECC) |
| `*.github.io`, `objects.githubusercontent.com`, `raw.githubusercontent.com` | ISRG Root X1 |
| `*.scdn.co` | GlobalSign Root CA - R3 |
| `loadspot.amd64fox1.workers.dev` | GTS Root R4 (cross-signed by GlobalSign Root CA) |

Windows receives the 2021 Sectigo root only through automatic root updates, which debloated,
LTSC or offline installs may lack. `src/BlockTheSpot.Core/Roots.pem` (13 public roots taken from
Apple's system root store, SHA-256 fingerprints inside) is consulted by `Downloads.ValidateCertificate`
only when the system chain fails for `UntrustedRoot`/`PartialChain` alone; the server's intermediates
are reused and the leaf must chain to one of the bundled roots. Any other TLS failure is fatal and
reported with the host and issuer, without retries. `testdata/github_com_chain_2026-09-18.pem` keeps
that day's chain for the regression test (verification time fixed to the capture date).
