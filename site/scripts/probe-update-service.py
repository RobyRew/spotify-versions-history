#!/usr/bin/env python3
"""Second sensor for the release watcher: asks Spotify's own update service what it would hand a
desktop client, the way the client does (docs/SPOTIFY_DOWNLOADS.md).

    GET https://spclient.wg.spotify.com/desktop-update/v2/update
    Authorization: Bearer <session token>   client-token: <...>
    App-Platform: Win32_x86_64 | Win32_ARM64 | OSX | OSX_ARM64
    Spotify-App-Version: <claimed version, old enough to be offered the current build>

The protobuf answer (client_update.proto) carries the target version, Spotify's http_prefix for the
installer, the signed http_suffix (?fauth=...) and Spotify's own binary_hash of the file. The watcher
cross-checks that hash against the file it downloads from the permanent URL.

Needs a logged-in Spotify session. One-time setup on your own machine:

    pip install "git+https://github.com/kokarare1212/librespot-python@683d9e76f91ba7ae03919494dac8d899ca505651"
    python3 site/scripts/probe-update-service.py --login --credentials credentials.json

which opens Spotify's OAuth page; the resulting credentials.json (reusable, no password inside) goes
into the SPOTIFY_CREDENTIALS repository secret. Without credentials the script exits 0 with
{"skipped": true} so the permanent-URL sensor keeps working alone.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import tempfile
import time
from dataclasses import dataclass, field
from urllib.parse import urlsplit

PLATFORMS = {
    "Win32_x86_64": ("windows", "x64"),
    "Win32_ARM64": ("windows", "arm64"),
    "OSX": ("macos", "x64"),
    "OSX_ARM64": ("macos", "arm64"),
}
FILENAME = re.compile(r"^(?:spotify_installer|spotify-autoupdate)-(1\.\d+\.\d+\.\d+\.g[0-9a-fA-F]+)-\d+\.(?:exe|tbz)$")


# --- minimal protobuf reader (no dependency; only what client_update.proto needs) -------------------

def read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result, shift = 0, 0
    while True:
        if pos >= len(data):
            raise ValueError("truncated varint")
        byte = data[pos]
        pos += 1
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")


def read_fields(data: bytes) -> dict[int, list[bytes | int]]:
    """Returns {field number: [values]} with ints for varints and bytes for length-delimited fields."""
    fields: dict[int, list[bytes | int]] = {}
    pos = 0
    while pos < len(data):
        key, pos = read_varint(data, pos)
        number, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = read_varint(data, pos)
        elif wire == 2:
            length, pos = read_varint(data, pos)
            if pos + length > len(data):
                raise ValueError("truncated bytes field")
            value = data[pos:pos + length]
            pos += length
        elif wire == 1:
            value, pos = int.from_bytes(data[pos:pos + 8], "little"), pos + 8
        elif wire == 5:
            value, pos = int.from_bytes(data[pos:pos + 4], "little"), pos + 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        fields.setdefault(number, []).append(value)
    return fields


def first(fields: dict[int, list], number: int, default=None):
    values = fields.get(number)
    return values[0] if values else default


@dataclass
class UpgradeOffer:
    platform: int
    target_version: int
    http_prefix: str
    http_suffix: str
    binary_hash: str
    upgrade_type: int
    flags: int
    poll_interval: int
    full_version: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def url(self) -> str:
        return self.http_prefix + self.http_suffix


def parse_update_response(payload: bytes) -> UpgradeOffer | None:
    """UpdateQueryResponse { 1: UpgradeRequiredMessage, 2: poll_interval }."""
    top = read_fields(payload)
    poll = first(top, 2, 0)
    message = first(top, 1)
    if not isinstance(message, (bytes, bytearray)):
        return None
    required = read_fields(bytes(message))
    signed = first(required, 10)
    if not isinstance(signed, (bytes, bytearray)):
        raise ValueError("UpgradeRequiredMessage without upgrade_signed_part")
    part = read_fields(bytes(signed))
    prefix = first(part, 5, b"")
    suffix = first(required, 30, b"")
    binary = first(part, 6, b"")
    offer = UpgradeOffer(
        platform=int(first(part, 1, 0)), target_version=int(first(part, 4, 0)),
        http_prefix=bytes(prefix).decode("utf-8", "replace"), http_suffix=bytes(suffix).decode("utf-8", "replace"),
        binary_hash=bytes(binary).hex(), upgrade_type=int(first(part, 7, 0)), flags=int(first(part, 10, 0)),
        poll_interval=int(poll) if isinstance(poll, int) else 0)
    name = urlsplit(offer.http_prefix).path.rsplit("/", 1)[-1]
    match = FILENAME.match(name)
    if match:
        offer.full_version = match.group(1)
    else:
        offer.warnings.append(f"unrecognised installer name {name!r}")
    if not offer.http_prefix.startswith("https://upgrade.scdn.co/upgrade/client/"):
        offer.warnings.append(f"unexpected prefix host in {offer.http_prefix!r}")
    return offer


# --- self-test with a synthetic message, so the decoder is checked without any account ------------------

def encode_varint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def encode_field(number: int, value) -> bytes:
    if isinstance(value, int):
        return encode_varint(number << 3) + encode_varint(value)
    return encode_varint((number << 3) | 2) + encode_varint(len(value)) + value


def self_test() -> None:
    prefix = b"https://upgrade.scdn.co/upgrade/client/win32-x86_64/spotify_installer-1.3.1.234.g59d6bf59-1234.exe"
    digest = bytes.fromhex("6c25d92dd38ddbfc1e4970765e865766d8ae2ef1758c6af8e9122c5050ee66dc")
    signed = encode_field(1, 1) + encode_field(4, 1301234) + encode_field(5, prefix) + encode_field(6, digest) + encode_field(7, 2) + encode_field(10, 3)
    required = encode_field(10, signed) + encode_field(20, b"sig") + encode_field(30, b"?fauth=abc.def")
    payload = encode_field(1, required) + encode_field(2, 14288)
    offer = parse_update_response(payload)
    assert offer is not None and offer.full_version == "1.3.1.234.g59d6bf59", offer
    assert offer.url == prefix.decode() + "?fauth=abc.def" and offer.binary_hash == digest.hex() and offer.poll_interval == 14288, offer
    assert offer.upgrade_type == 2 and offer.flags == 3 and not offer.warnings, offer
    assert parse_update_response(encode_field(2, 14288)) is None, "no upgrade must decode to None"
    token = base64.urlsafe_b64encode(b'{"alg":"RS256"}').decode().rstrip("=") + "." + base64.urlsafe_b64encode(b'{"iss":"scdn-url-signer","exp":1792311229}').decode().rstrip("=") + ".sig"
    assert signed_until("?fauth=" + token) == "2026-10-18T08:13:49Z", signed_until("?fauth=" + token)
    assert signed_until("?fauth=abc.def") is None
    print("self-test passed")


# --- live probe -----------------------------------------------------------------------------------------

def prefer_accesspoints(ports: tuple[str, ...]) -> None:
    """librespot picks an access point at random, including ones on port 80, which some networks refuse."""
    from librespot.core import ApResolver

    original = getattr(ApResolver, "_original_get_random_of", ApResolver.get_random_of)
    ApResolver._original_get_random_of = original

    def preferred(service_type: str) -> str:
        if service_type != "accesspoint":
            return original(service_type)
        urls = ApResolver.request(service_type).get(service_type, [])
        chosen = next((url for port in ports for url in urls if url.endswith(port)), None) or original(service_type)
        print(f"access point: {chosen}", file=sys.stderr, flush=True)
        return chosen

    ApResolver.get_random_of = staticmethod(preferred)


def open_session(credentials_path: str | None, login: bool):
    from librespot.core import Session  # imported lazily: the dependency is only needed for live use

    # One refused connection was observed on an otherwise working network; the second attempt swaps the port order.
    for attempt, ports in enumerate(((":4070", ":443"), (":443", ":4070"))):
        prefer_accesspoints(ports)
        builder = Session.Builder()
        try:
            if login:
                builder.conf.stored_credentials_file = credentials_path
                builder.conf.store_credentials = True
                # The callback lands on 127.0.0.1:5588, so the link must be opened on the machine running this script.
                show = lambda url: print(f"\nOpen this link in a browser on this machine and log in with the account to store:\n{url}\n", file=sys.stderr, flush=True)
                return builder.oauth(show).create()
            builder.conf.store_credentials = False
            return builder.stored_file(credentials_path).create()
        except ConnectionError as error:
            if attempt or login:
                raise
            print(f"access point connection failed ({error}); retrying on the other port", file=sys.stderr, flush=True)
            time.sleep(3)


def probe(session, platform: str, claim: str) -> dict:
    headers = {"App-Platform": platform, "Spotify-App-Version": claim, "Accept": "application/x-protobuf"}
    response = session.api().send("GET", f"/desktop-update/v2/update?client_version={claim}&ct=S", headers, None)
    record = {"platform": platform, "status": response.status_code, "contentType": response.headers.get("content-type")}
    if response.status_code != 200:
        record["error"] = response.text[:300]
        return record
    try:
        offer = parse_update_response(response.content)
    except ValueError as error:
        record["error"] = f"decode: {error}"
        record["raw"] = base64.b64encode(response.content).decode()
        return record
    if offer is None:
        record["upToDate"] = True
        return record
    os_name, arch = PLATFORMS[platform]
    record.update({"fullVersion": offer.full_version, "os": os_name, "architecture": arch, "httpPrefix": offer.http_prefix,
                   "url": offer.url, "signedUntil": signed_until(offer.http_suffix), "binaryHash": offer.binary_hash,
                   "targetVersion": offer.target_version, "upgradeType": offer.upgrade_type, "flags": offer.flags,
                   "pollInterval": offer.poll_interval, "warnings": offer.warnings})
    return record


def signed_until(http_suffix: str) -> str | None:
    """Expiry of the ?fauth= token: a JWT from scdn-url-signer whose payload carries exp (read, not verified)."""
    match = re.match(r"^\?fauth=[^.]+\.([A-Za-z0-9_-]+)\.", http_suffix)
    if not match:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(match.group(1) + "=" * (-len(match.group(1)) % 4)))
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(payload["exp"])))
    except (ValueError, KeyError, TypeError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--login", action="store_true", help="run Spotify's OAuth flow once and save reusable credentials")
    parser.add_argument("--credentials", default=os.environ.get("SPOTIFY_CREDENTIALS_FILE"), help="path to credentials.json")
    parser.add_argument("--claim", default="1.2.0.0", help="version the probe claims to run; old enough to be offered the current build")
    parser.add_argument("--platforms", default=",".join(PLATFORMS), help="comma-separated App-Platform values")
    parser.add_argument("--self-test", action="store_true", help="check the protobuf decoder against a synthetic message")
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0
    inline = os.environ.get("SPOTIFY_CREDENTIALS")
    if not args.credentials and inline:
        handle = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        handle.write(inline)
        handle.close()
        args.credentials = handle.name
    if not args.credentials:
        print(json.dumps({"skipped": True, "reason": "no credentials"}))
        return 0
    try:
        session = open_session(args.credentials, args.login)
    except ImportError:
        print(json.dumps({"skipped": True, "reason": "librespot is not installed"}))
        return 0
    if args.login:
        print(f"Credentials saved to {args.credentials}", file=sys.stderr)
    results = {}
    for platform in [p.strip() for p in args.platforms.split(",") if p.strip()]:
        if platform not in PLATFORMS:
            results[platform] = {"platform": platform, "error": "unknown platform"}
            continue
        results[platform] = probe(session, platform, args.claim)
        time.sleep(1)
    try:
        session.close()
    except Exception:  # noqa: BLE001 - closing is best effort
        pass
    print(json.dumps({"checkedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "claim": args.claim, "results": results}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
