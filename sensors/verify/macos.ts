/**
 * macOS DMGs, checked with the system's own tools on a macOS host (GitHub's macos-latest runners):
 * hdiutil mounts the image read-only, then on the app inside
 *  - codesign --verify --deep --strict: the signature and every nested code signature hold;
 *  - codesign -dvvv: Identifier, TeamIdentifier and the authority chain equal the pinned ones;
 *  - spctl --assess --type execute: Gatekeeper accepts it as notarized Developer ID software;
 * and on the image: stapler validate (Spotify staples the notarization ticket to the DMG, not to the
 * app) and whether the image itself is signed (Spotify's DMGs are not, which is a skip, not a fail).
 * The output parsers are pure functions, tested on outputs recorded from a real DMG.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrustAnchors } from '../../lib/trust.ts';
import { parsePlist } from '../lib/plist.ts';
import { fail, pass, skip, type Check } from './types.ts';

const IDS = ['macos.codesign-verify', 'macos.signer', 'macos.gatekeeper', 'macos.notarization-ticket', 'macos.dmg-signature', 'macos.bundle-version'] as const;

interface Run { code: number; output: string }

const run = (command: string, args: string[], timeoutMs = 300_000): Promise<Run> => new Promise(resolve => {
  execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
    resolve({ code, output: `${stdout}${stderr}` });
  });
});

export function parseCodesignVerify(output: string, code: number): { ok: boolean; detail: string } {
  const valid = /: valid on disk$/m.test(output);
  const requirement = /: satisfies its Designated Requirement$/m.test(output);
  const ok = code === 0 && valid && requirement;
  return { ok, detail: ok ? 'valid on disk and satisfies its Designated Requirement' : `exit ${code}: ${output.trim().split('\n').slice(-2).join(' | ')}` };
}

export interface CodesignDisplay {
  identifier: string | null;
  teamIdentifier: string | null;
  authorities: string[];
  timestamp: string | null;
  cdhash: string | null;
  hardenedRuntime: boolean;
}

export function parseCodesignDisplay(output: string): CodesignDisplay {
  const value = (name: string) => new RegExp(`^${name}=(.*)$`, 'm').exec(output)?.[1]?.trim() ?? null;
  return {
    identifier: value('Identifier'),
    teamIdentifier: value('TeamIdentifier'),
    authorities: [...output.matchAll(/^Authority=(.*)$/gm)].map(match => match[1]!.trim()),
    timestamp: value('Timestamp'),
    cdhash: value('CDHash'),
    hardenedRuntime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b[^)]*\)/m.test(output),
  };
}

export function parseSpctl(output: string, code: number): { accepted: boolean; source: string | null } {
  return { accepted: code === 0 && /: accepted$/m.test(output), source: /^source=(.*)$/m.exec(output)?.[1]?.trim() ?? null };
}

export function parseStapler(output: string, code: number): boolean {
  return code === 0 && /The validate action worked!/.test(output);
}

/** Detaches every volume hdiutil mounted under `mountRoot` (it creates one directory per volume there). */
async function detachAll(mountRoot: string): Promise<void> {
  let entries: string[] = [];
  try { entries = await readdir(mountRoot); } catch { return; }
  for (const entry of entries) {
    const point = join(mountRoot, entry);
    if ((await run('hdiutil', ['detach', point, '-quiet'])).code !== 0) await run('hdiutil', ['detach', point, '-force', '-quiet']);
  }
}

export async function verifyDmg(file: string, trust: TrustAnchors, expected: { version: string }): Promise<Check[]> {
  if (process.platform !== 'darwin') return IDS.map(id => skip(id, 'macOS tools', 'codesign, spctl and stapler run on the macOS host'));
  const anchor = trust.macos;
  const checks: Check[] = [];
  const mountRoot = await mkdtemp(join(tmpdir(), 'svh-dmg-'));
  try {
    const attach = await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountrandom', mountRoot, file]);
    if (attach.code !== 0) return IDS.map(id => fail(id, 'hdiutil', `the image could not be mounted: exit ${attach.code}: ${attach.output.trim().slice(0, 300)}`));
    // -mountrandom creates one directory per mounted volume under mountRoot.
    const volumes = await readdir(mountRoot);
    if (volumes.length !== 1) return IDS.map(id => fail(id, 'hdiutil', `expected one mounted volume, found ${volumes.length}`));
    const mounted = join(mountRoot, volumes[0]!);
    const apps = (await readdir(mounted)).filter(name => name.endsWith('.app'));
    if (apps.length !== 1) return IDS.map(id => fail(id, 'hdiutil', `expected one app at the top of the image, found ${apps.join(', ') || 'none'}`));
    const app = join(mounted, apps[0]!);

    const verify = await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const verified = parseCodesignVerify(verify.output, verify.code);
    checks.push(verified.ok ? pass('macos.codesign-verify', 'codesign', verified.detail) : fail('macos.codesign-verify', 'codesign', verified.detail));

    const display = parseCodesignDisplay((await run('codesign', ['-dvvv', app])).output);
    const problems: string[] = [];
    if (display.identifier !== anchor.identifier) problems.push(`Identifier: expected ${anchor.identifier}, found ${display.identifier}`);
    if (display.teamIdentifier !== anchor.teamId) problems.push(`TeamIdentifier: expected ${anchor.teamId}, found ${display.teamIdentifier}`);
    if (display.authorities.join(' <- ') !== anchor.authorities.join(' <- ')) problems.push(`Authority: expected ${anchor.authorities.join(' <- ')}, found ${display.authorities.join(' <- ') || 'none'}`);
    if (!display.timestamp) problems.push('no secure timestamp');
    if (!display.hardenedRuntime) problems.push('the hardened runtime flag, which notarization requires, is not set');
    checks.push(problems.length === 0
      ? pass('macos.signer', 'codesign', `${display.identifier}, team ${display.teamIdentifier}, ${display.authorities.join(' <- ')}, signed ${display.timestamp}`, { ...display })
      : fail('macos.signer', 'codesign', problems.join('; '), { ...display }));

    const assessment = await run('spctl', ['--assess', '--type', 'execute', '--verbose=4', app]);
    const gatekeeper = parseSpctl(assessment.output, assessment.code);
    checks.push(gatekeeper.accepted && gatekeeper.source === 'Notarized Developer ID'
      ? pass('macos.gatekeeper', 'spctl', `accepted, source=${gatekeeper.source}`)
      : fail('macos.gatekeeper', 'spctl', `exit ${assessment.code}: ${assessment.output.trim().split('\n').join(' | ')}`));

    const stapled = await run('xcrun', ['stapler', 'validate', file]);
    checks.push(parseStapler(stapled.output, stapled.code)
      ? pass('macos.notarization-ticket', 'stapler', 'a valid notarization ticket is stapled to the image')
      : fail('macos.notarization-ticket', 'stapler', `exit ${stapled.code}: ${stapled.output.trim().split('\n').slice(-1)[0] ?? ''}`));

    const image = await run('codesign', ['-dvvv', file]);
    if (/code object is not signed at all/.test(image.output)) {
      checks.push(skip('macos.dmg-signature', 'codesign', 'the image itself is not signed; the app inside is, and its ticket is stapled to the image'));
    } else {
      const imageDisplay = parseCodesignDisplay(image.output);
      checks.push(image.code === 0 && imageDisplay.teamIdentifier === anchor.teamId
        ? pass('macos.dmg-signature', 'codesign', `the image is signed by team ${imageDisplay.teamIdentifier}`)
        : fail('macos.dmg-signature', 'codesign', `the image is signed, but not by team ${anchor.teamId}: ${image.output.trim().slice(0, 300)}`));
    }

    const info = parsePlist(new Uint8Array(await readFile(join(app, 'Contents', 'Info.plist')))) as Record<string, unknown>;
    const version = info.CFBundleShortVersionString;
    const identifier = info.CFBundleIdentifier;
    checks.push(version === expected.version && identifier === anchor.identifier
      ? pass('macos.bundle-version', 'Info.plist', `${identifier} ${version}`)
      : fail('macos.bundle-version', 'Info.plist', `expected ${anchor.identifier} ${expected.version}, found ${String(identifier)} ${String(version)}`));
    return checks;
  } finally {
    await detachAll(mountRoot);
    // A volume that would not detach keeps its directory; the leftover is reported by the OS, not hidden by a throw here.
    await rm(mountRoot, { recursive: true, force: true }).catch(() => {});
  }
}
