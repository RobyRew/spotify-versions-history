# Verification of captured builds

Every build the archive records goes through checks that tie the file to its publisher. Those checks
use the same evidence a user's own system uses (the platform signature, the store's signed index),
plus two independent implementations wherever one exists. This page says what is checked, against
which pinned identities, and how anyone can repeat each check by hand.

The code lives in `sensors/verify/` (one module per platform). `sensors/verify.ts` runs it over the
builds a detection found (`sensors/run.ts detect --json`). `.github/workflows/verify.yml` runs it
every day on Linux, macOS and Windows runners and merges the three reports.

## Verification levels

| Level | Meaning |
| --- | --- |
| `signed` | The platform signature verifies and chains to a pinned root, with the pinned signer identity. |
| `spotify-digest` | The file's hash equals the one Spotify's desktop update service named for it. |
| `store-digest` | The hash equals the one a distribution store states (Microsoft, Canonical, Spotify's apt index). |
| `third-party-digest` | The hash equals one a package manager states (winget, Scoop, Chocolatey). |
| `unverified` | None of the above. |

A build is **ok** only when no check failed on any host and every host hashed the same bytes. A build
that changed upstream between detection and download is reported as rotated, which is not a failure;
the next run captures the new one.

## What is checked, per platform

| Platform | In-process checks (every host) | Native tools | Second implementation |
| --- | --- | --- | --- |
| Windows installers (`.exe`) | PE image digest, signer signature, signer subject and issuer, chain to the pinned root at the signing time, RFC 3161 timestamp, machine type and ProductVersion | `Get-AuthenticodeSignature`, `signtool verify /pa` (Windows) | `osslsigncode verify` (Linux) |
| Microsoft Store packages | the five digests the package signature covers (AXPC and AXCD over the zip structure, AXCT, AXBM, AXCI), every 64 KiB block of every file against `AppxBlockMap.xml`, the `AppxManifest.xml` identity, signer, chain, timestamp, and the SHA-256 that displaycatalog and FE3 state | `Get-AuthenticodeSignature`, `signtool verify /pa` (Windows) | the Windows host's tools; `osslsigncode` cannot check these (its OpenSSL stops at the critical Application Policies extension) |
| macOS (`.dmg`) | digest against the CDN's MD5 ETag | `codesign --verify --deep --strict`, `codesign -dvvv` (identifier, Team ID, authorities, hardened runtime), `spctl --assess`, `stapler validate` on the image, `Info.plist` version (macOS) | — |
| Linux apt (`.deb`) | `InRelease` OpenPGP signature by the pinned key, valid when made and now; `Packages` SHA-256 listed in `InRelease`; `.deb` SHA-256 listed in `Packages`; the `control` file's Package, Version and Architecture | — | `gpgv` (Linux) |
| Linux snap (`.snap`) | the snap-revision assertion signed by Canonical's store key, that key's account-key assertion signed by snapd's root key, the root's self-signature and pinned id, the keys' validity windows, the file's SHA3-384 and size, snap-id, developer-id and the snap-declaration's name | — | — |

Three facts the real files showed, which the checks rely on:

- Spotify's DMG is not signed itself. The app inside is, and the notarization ticket is stapled to the
  image, not to the app. So `macos.dmg-signature` is a skip and `stapler validate` runs on the image.
- Microsoft's Store signing certificates carry a critical Application Policies extension
  (1.3.6.1.4.1.311.21.10) that repeats their extended key usage. The chain check requires the code
  signing purpose in it, as CryptoAPI does. The intermediate CA rotates (Marketplace CA G 023 signed
  1.253.440.0, G 026 signed 1.310.2586.0), so only the root and the publisher are pinned.
- Microsoft's Time-Stamp Service certificates of 2022 (in the Store's 1.192.647.0 x86 package) do not
  mark their time-stamping extended key usage critical, as RFC 3161 asks. The check requires
  id-kp-timeStamping as the only usage and enforces it itself, so it accepts them, as Windows does.
  That package's signer certificate was valid for three days in August 2022; the chain is checked at
  the timestamp's time.
- AXCD is the SHA-256 of the central directory without the signature file's record, followed by the
  ZIP64 end records rewritten as if that file were absent. This definition was matched against the
  signed values of two real packages.

## Pinned identities

`ledger/trust/anchors.json` holds every identity a build must carry. Each entry records when and
from what it was read. Root certificates are PEM files in `ledger/trust/certificates/`, pinned by
SHA-256. A verifier given a file whose fingerprint differs from the pin refuses to run.

| Anchor | Value |
| --- | --- |
| Windows signer | `CN=Spotify AB, O=Spotify AB, L=Stockholm, C=SE, serialNumber=556703-7485` (EV), issued by DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1 |
| Windows roots | DigiCert Trusted Root G4 (`552F7BDC…0AC89988`) for the signature and the timestamp |
| Store publisher | `CN=453637B3-4E12-4CDF-B0D3-2A3C863BF6EF`, package family `SpotifyAB.SpotifyMusic_zpdnekdrzrea0` |
| Store roots | Microsoft Root Certificate Authority 2011 (`847DF6A7…07ED7C61`) for the package signature and for the TLS of `fe3.delivery.mp.microsoft.com`; Microsoft Root Certificate Authority 2010 (`DF545BF9…6F3C163E`) for the timestamp |
| macOS | Team ID `2FNC3A47ZF`, identifier `com.spotify.client`, authorities Developer ID Application: Spotify (2FNC3A47ZF) → Developer ID Certification Authority → Apple Root CA |
| apt | key `E1096BCBFF6D418796DE78515384CE82BA52C83A` (`ledger/trust/apt/`), created 2025-11-21, expires 2027-02-14 |
| snap | snapd's root account-key `-CvQKAwRQ5h3Ffn10FILJoEZUXOv6km9FwA80-Rcj-f-6jadQ89VRswHNiEB9Lxk` (`ledger/trust/snap/`), snap-id `pOBIoZ2LrCB3rDohMxoYGnbN14EHOgD7`, developer-id `Z7emHVerQzTDQrOcaLJ8wO1ir1NPl3fG` |

### When an anchor changes

Spotify renews its Windows certificate every year or so. Its apt key rotates every November. Microsoft
moves Store signing to new intermediate CAs. In each case the checks fail closed and the daily run
opens a `sensor-alert` issue. To accept a change:

1. Read the new value from at least two sources (for example the file itself and the vendor's
   published key or certificate).
2. Write it to `anchors.json` (and the PEM or key file) with `observed.at` and `observed.from`.
3. Commit it on its own, so the change is easy to review.

## Microsoft Store downloads (FE3)

The Store sensor reads displaycatalog for the package names and SHA-256 hashes. To download, the
capture asks Windows Update's delivery service, the same one a Windows PC uses, without any account:

1. `GetCookie`.
2. `SyncUpdates` with the product's WuCategoryId. Repeat it, reporting the prerequisite updates as
   installed, until the package updates appear (three rounds today).
3. `GetExtendedUpdateInfo2` for the package's update id, which returns a link valid for about 80
   minutes.

The TLS of `fe3.delivery.mp.microsoft.com` chains to Microsoft Root Certificate Authority 2011, which
is not in Node's bundled roots, so only those requests add the pinned root. The download host
(`tlu.dl.delivery.mp.microsoft.com`) serves no valid HTTPS certificate. The file therefore comes over
http and is accepted only when its SHA-256 and SHA-1 equal the ones FE3 stated over TLS, and its
signature verifies.

## Link health and alerts

`sensors/health.ts` asks every download link the ledger records whether it still answers, and
`.github/workflows/health.yml` runs it every six hours:

- Spotify's current-build URLs and apt pool are checked on every run.
- Signed `upgrade.scdn.co` links are marked expired from their token, without a request.
- The LoadSpot mirror and the other links are checked once a week each: a seventh of them per day,
  at most two requests at a time to the mirror.

Results carry over between runs through the Actions cache. A dead link is data for the site, not a
failure.

Two things open an issue labelled `sensor-alert`: one of Spotify's current-build URLs not answering,
and the mirror failing for most of the links checked in a run. The verify workflow also opens one per
sensor whose current build is not ok. Each issue is found again by a hidden marker in its body and
gets a comment only when the failure changes. The next clean run closes it.

## Repeat the checks yourself

Windows (PowerShell):

```powershell
Get-AuthenticodeSignature .\SpotifyFullSetupX64.exe | Format-List Status, SignerCertificate, TimeStamperCertificate
```

Linux, a Windows installer:

```bash
osslsigncode verify -in SpotifyFullSetupX64.exe -CAfile ledger/trust/certificates/DigiCertTrustedRootG4.pem -TSA-CAfile ledger/trust/certificates/DigiCertTrustedRootG4.pem
```

macOS, inside the mounted DMG:

```bash
codesign --verify --deep --strict --verbose=2 /Volumes/Spotify/Spotify.app && codesign -dvvv /Volumes/Spotify/Spotify.app 2>&1 | grep -E '^(Authority|TeamIdentifier)'
```

```bash
spctl --assess --type execute --verbose=4 /Volumes/Spotify/Spotify.app
```

apt:

```bash
gpgv --keyring ledger/trust/apt/spotify-5384CE82BA52C83A.gpg InRelease
```

The SHA-256 of `non-free/binary-amd64/Packages` must be the one `InRelease` lists, and the `.deb`'s
SHA-256 the one `Packages` lists.

snap (on a machine with snapd):

```bash
snap download spotify --revision=<N> && sudo snap ack spotify_<N>.assert && sudo snap install spotify_<N>.snap
```

`snap install` refuses a file whose digest the acknowledged assertions don't name.
