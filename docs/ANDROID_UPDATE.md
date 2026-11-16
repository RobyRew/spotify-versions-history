# Android update check

Recorded 2026-11-16. No APK was opened in this pass. The notes below are the capture to do on a device that has the Play build of `com.spotify.music`, plus what is already known from the desktop sensors.

## What is already true

Desktop installers come from `download.scdn.co` (one permanent URL per architecture, always the current build) and from `desktop-update/v2/update` (a signed `upgrade.scdn.co` URL, about 30 days). Linux debs are versioned paths on `repository.spotify.com`. None of those hosts has published an Android APK in the catalog.

The Play listing is the install path Google documents for Spotify. A public APK mirror is not a Spotify origin and is not added as a source.

## What to capture on the device

On a signed-in official build, log the request the app makes when it looks for an update (the Play in-app update call, or any request to `*.scdn.co` / `*.spotify.com` whose path contains `update` or `apk`):

- host, path, and whether the response is a URL
- if it is a URL: does it answer without a Play token, and does the path look like `upgrade.scdn.co` or `download.scdn.co`
- the version string in the response, and any hash field

If that response is an ordinary HTTPS object on a Spotify host, it gets the same treatment as a desktop offer: download while the signature lasts, record SHA-256, and copy to B2 only when the signature is about to die and amd64fox does not already answer 200 with that hash.

If the response is a Play delivery token, the catalog row stays a version record. There is no file to archive.

## iOS, for the same reason

`https://itunes.apple.com/lookup?bundleId=com.spotify.client` returns the App Store version and date for `com.spotify.client`. iPadOS uses that same bundle. The lookup does not include an IPA. Apple's asset URLs are tied to the device, so they are not stored as downloads.
