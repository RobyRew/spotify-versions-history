#!/usr/bin/env bash
# Records the public responses the sensors parse into testdata/channels/, so parser tests run on
# real payloads and anyone can re-record and diff them. Only metadata is recorded: headers, JSON,
# signed apt indexes and store assertions, never an installer. Needs curl; run from the repo root:
#   bash scripts/record-fixtures.sh
set -euo pipefail

out=testdata/channels
ua='spotify-versions-history fixture recorder (+https://github.com/RobyRew/spotify-versions-history)'
fetch() { curl -sS --fail --max-time 60 -A "$ua" "$@"; }
# Response headers only, CR stripped, volatile ones (dates, request ids, caches) dropped.
headers() {
  fetch -I "$1" | tr -d '\r' | grep -i -E '^(HTTP/|content-length|content-type|etag|last-modified|x-goog-generation|x-goog-hash|x-amz-checksum)' || true
}

mkdir -p "$out"/{windows,macos,apt,snap,store,ios,loadspot}

for file in SpotifyFullSetupX64.exe SpotifyFullSetupARM64.exe SpotifyFullSetup.exe SpotifySetup.exe; do
  headers "https://download.scdn.co/$file" > "$out/windows/head-$file.txt"
done
for file in Spotify.dmg SpotifyARM64.dmg SpotifyInstaller.zip; do
  headers "https://download.scdn.co/$file" > "$out/macos/head-$file.txt"
done

for suite in stable testing; do
  fetch "https://repository.spotify.com/dists/$suite/InRelease" > "$out/apt/$suite-InRelease"
  fetch "https://repository.spotify.com/dists/$suite/non-free/binary-amd64/Packages" > "$out/apt/$suite-amd64-Packages"
done

fetch -H 'Snap-Device-Series: 16' 'https://api.snapcraft.io/v2/snaps/info/spotify?fields=channel-map,revision,version,download,created-at,base,confinement,publisher' > "$out/snap/info.json"
# The Canonical-signed snap-revision assertion of the stable amd64 revision, looked up by its sha3-384.
sha=$(python3 -I -c 'import json,sys; m=json.load(open(sys.argv[1]))["channel-map"]; e=[x for x in m if x["channel"]["name"]=="stable" and x["channel"]["architecture"]=="amd64"][0]; print(e["download"]["sha3-384"])' "$out/snap/info.json")
key=$(python3 -I -c 'import base64,sys; print(base64.urlsafe_b64encode(bytes.fromhex(sys.argv[1])).decode().rstrip("="))' "$sha")
fetch -H 'Accept: application/x.ubuntu.assertion' "https://assertions.ubuntu.com/v1/assertions/snap-revision/$key" > "$out/snap/snap-revision-stable.assert"

# Listing payloads are cut down to the fields the parsers read: store descriptions, release notes and
# screenshots are not copied into this repository.
trim() { python3 -I -c "$1" "$2"; }

fetch 'https://displaycatalog.mp.microsoft.com/v7.0/products/9NCBCSZSJRSB?market=US&languages=en-US&fieldsTemplate=Details' > "$out/store/displaycatalog.json"
trim '
import json, sys
path = sys.argv[1]; product = json.load(open(path))["Product"]
pick = lambda d, keys: {k: d[k] for k in keys if k in d}
skus = [{"Sku": {**pick(a["Sku"], ["SkuId", "LastModifiedDate"]), "Properties": {
    **pick(a["Sku"]["Properties"], ["FulfillmentData", "LastUpdateDate", "VersionString"]),
    "Packages": [pick(p, ["PackageFullName", "PackageFamilyName", "PackageId", "ContentId", "Architectures", "Version",
        "PackageFormat", "Hash", "HashAlgorithm", "MaxDownloadSizeInBytes", "PackageDownloadUris"]) for p in a["Sku"]["Properties"].get("Packages", [])]}}}
    for a in product["DisplaySkuAvailabilities"]]
out = {"Product": {**pick(product, ["LastModifiedDate", "ProductId"]),
    "Properties": pick(product["Properties"], ["PackageFamilyName", "PackageIdentityName", "PublisherCertificateName", "PublisherId"]),
    "DisplaySkuAvailabilities": skus}}
json.dump(out, open(path, "w"), indent=2); open(path, "a").write("\n")' "$out/store/displaycatalog.json"

fetch 'https://itunes.apple.com/lookup?id=324684580&country=us' > "$out/ios/itunes-lookup-us.json"
trim '
import json, sys
path = sys.argv[1]; data = json.load(open(path))
keys = ["trackId", "bundleId", "trackName", "sellerName", "version", "currentVersionReleaseDate", "releaseDate",
        "minimumOsVersion", "fileSizeBytes", "trackViewUrl", "supportedDevices"]
out = {"resultCount": data["resultCount"], "results": [{k: r[k] for k in keys if k in r} for r in data["results"]]}
json.dump(out, open(path, "w"), indent=2); open(path, "a").write("\n")' "$out/ios/itunes-lookup-us.json"

fetch 'https://raw.githubusercontent.com/LoaderSpot/table/main/latest.json' > "$out/loadspot/latest.json"
fetch 'https://raw.githubusercontent.com/LoaderSpot/table/main/table/versions.json' > "$out/loadspot/versions.json"
# The newest six versions are enough for the parser tests.
trim '
import json, sys
path = sys.argv[1]; data = json.load(open(path))
json.dump(dict(list(data.items())[:6]), open(path, "w"), indent=2); open(path, "a").write("\n")' "$out/loadspot/versions.json"

date -u +%Y-%m-%dT%H:%M:%SZ > "$out/RECORDED_AT"
echo "Recorded into $out at $(cat "$out/RECORDED_AT")"
