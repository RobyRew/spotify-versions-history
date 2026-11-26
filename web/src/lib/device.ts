/**
 * The visitor's desktop system, to put its download first. Read from the request on every render and
 * never stored. Chromium sends `Sec-CH-UA-Platform` by default and the architecture hints once the
 * middleware's `Accept-CH` has asked for them; other browsers only have the User-Agent, which on a Mac
 * says "Intel" on every model, so a Mac without hints gets the ARM64 build.
 */
import type { Arch, Platform } from '../../../lib/site/model.ts';

export interface Device {
  platform: Extract<Platform, 'windows' | 'macos' | 'linux'>;
  arch: Arch;
  /** True when the architecture came from a client hint rather than a default. */
  archKnown: boolean;
}

const unquote = (value: string | null): string => (value ?? '').replace(/^"|"$/g, '').trim().toLowerCase();

export function deviceFromHeaders(headers: Headers): Device | null {
  const agent = headers.get('user-agent') ?? '';
  const hinted = unquote(headers.get('sec-ch-ua-platform'));
  const mobile = headers.get('sec-ch-ua-mobile') === '?1' || /iPhone|iPad|Android|Mobile/.test(agent);
  if (mobile) return null;

  const platform: Device['platform'] | null =
    hinted === 'windows' ? 'windows'
    : hinted === 'macos' ? 'macos'
    : hinted === 'linux' ? 'linux'
    : /Windows/.test(agent) ? 'windows'
    : /Macintosh|Mac OS X/.test(agent) ? 'macos'
    : /Linux|X11/.test(agent) && !/CrOS/.test(agent) ? 'linux'
    : null;
  if (!platform) return null;

  const hintArch = unquote(headers.get('sec-ch-ua-arch'));
  const bitness = unquote(headers.get('sec-ch-ua-bitness'));
  if (hintArch === 'arm') return { platform, arch: 'arm64', archKnown: true };
  if (hintArch === 'x86') return { platform, arch: bitness === '32' && platform === 'windows' ? 'x86' : 'x64', archKnown: true };
  if (platform === 'windows') return { platform, arch: /ARM64|aarch64/i.test(agent) ? 'arm64' : 'x64', archKnown: /ARM64|aarch64/i.test(agent) };
  if (platform === 'linux') return { platform, arch: /aarch64|arm64/i.test(agent) ? 'arm64' : 'x64', archKnown: false };
  return { platform, arch: 'arm64', archKnown: false };
}

/** The response headers that ask Chromium for the architecture hints and keep caches per system. */
export const DEVICE_HINT_HEADERS = {
  'Accept-CH': 'Sec-CH-UA-Platform, Sec-CH-UA-Arch, Sec-CH-UA-Bitness',
  Vary: 'User-Agent, Sec-CH-UA-Platform, Sec-CH-UA-Arch, Sec-CH-UA-Bitness',
} as const;
