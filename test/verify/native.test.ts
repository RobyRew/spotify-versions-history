import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCertificates, type TrustAnchors } from '../../lib/trust.ts';
import { parseCodesignDisplay, parseCodesignVerify, parseSpctl, parseStapler } from '../../sensors/verify/macos.ts';
import { parseOsslsigncode } from '../../sensors/verify/osslsigncode.ts';
import { dotnetName, windowsChecks, WindowsReport } from '../../sensors/verify/windows.ts';
import { here, trust as loadTrust } from '../sensors/helpers.ts';

const recorded = (name: string) => readFile(here(`../../testdata/verify/macos/${name}.txt`), 'utf8');

describe('macOS tool output (recorded from the real SpotifyARM64.dmg)', () => {
  it('reads a deep strict codesign verification', async () => {
    expect(parseCodesignVerify(await recorded('codesign-verify'), 0).ok).toBe(true);
    expect(parseCodesignVerify(await recorded('codesign-verify'), 1).ok).toBe(false);
    // Hand-written: what codesign prints for a modified bundle.
    expect(parseCodesignVerify('/Volumes/Spotify/Spotify.app: a sealed resource is missing or invalid\n', 1).ok).toBe(false);
  });

  it('reads identifier, team, authorities, timestamp and the hardened runtime flag', async () => {
    expect(parseCodesignDisplay(await recorded('codesign-display'))).toEqual({
      identifier: 'com.spotify.client',
      teamIdentifier: '2FNC3A47ZF',
      authorities: ['Developer ID Application: Spotify (2FNC3A47ZF)', 'Developer ID Certification Authority', 'Apple Root CA'],
      timestamp: '13 Nov 2026 at 18:14:05',
      cdhash: '08bf662ce9de07191fcbe5225f739f442f2981c9',
      hardenedRuntime: true,
    });
  });

  it('reads Gatekeeper and stapler verdicts', async () => {
    expect(parseSpctl(await recorded('spctl-app'), 0)).toEqual({ accepted: true, source: 'Notarized Developer ID' });
    expect(parseSpctl(await recorded('spctl-dmg'), 3).accepted).toBe(false);
    // Hand-written: an app Gatekeeper rejects.
    expect(parseSpctl('/Volumes/Spotify/Spotify.app: rejected\nsource=Unnotarized Developer ID\n', 3).accepted).toBe(false);
    expect(parseStapler(await recorded('stapler-dmg'), 0)).toBe(true);
    expect(parseStapler(await recorded('stapler-app'), 65)).toBe(false);
    expect(await recorded('codesign-dmg')).toMatch(/code object is not signed at all/);
  });
});

describe('Windows report (hand-written samples in .NET\'s formats)', () => {
  let anchors: TrustAnchors;
  let digicert: string;
  let microsoft: string;
  beforeAll(async () => {
    anchors = await loadTrust();
    const directory = here('../../ledger/trust');
    digicert = (await loadCertificates(anchors, ['digicert-trusted-root-g4'], directory))[0]!.fingerprint.replaceAll(':', '');
    microsoft = (await loadCertificates(anchors, ['microsoft-root-2011'], directory))[0]!.fingerprint.replaceAll(':', '');
  });

  const spotifySubject = 'CN=Spotify AB, O=Spotify AB, L=Stockholm, C=SE, SERIALNUMBER=556703-7485, OID.2.5.4.15=Private Organization, OID.1.3.6.1.4.1.311.60.2.1.3=SE';
  const report = (overrides: Partial<WindowsReport> = {}): WindowsReport => WindowsReport.parse({
    status: 'Valid', statusMessage: 'Signature verified.', signatureType: 'Authenticode',
    signer: { subject: spotifySubject, issuer: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1, O="DigiCert, Inc.", C=US', thumbprint: 'ABCDEF', notBefore: '2025-11-01T00:00:00.0000000Z', notAfter: '2027-11-01T23:59:59.0000000Z' },
    timestamper: { subject: 'CN=DigiCert SHA256 RSA4096 Timestamp Responder 2026 1, O="DigiCert, Inc.", C=US', issuer: 'CN=DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1, O="DigiCert, Inc.", C=US' },
    chain: { built: true, elements: [{ subject: spotifySubject, thumbprint: 'ABCDEF' }, { subject: 'CN=DigiCert Trusted G4 Code Signing RSA4096 SHA384 2021 CA1', thumbprint: '1234' }, { subject: 'CN=DigiCert Trusted Root G4, OU=www.digicert.com, O=DigiCert Inc, C=US', thumbprint: digicert }], status: [] },
    signtool: { path: 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\signtool.exe', exitCode: 0, output: 'Verifying: SpotifyFullSetupX64.exe\r\nSuccessfully verified: SpotifyFullSetupX64.exe\r\n' },
    ...overrides,
  });

  it('reads .NET subject names with OID prefixes and quoted values', () => {
    expect(dotnetName('O="DigiCert, Inc.", OID.2.5.4.15=Private Organization')).toEqual([
      { oid: '2.5.4.10', value: 'DigiCert, Inc.' }, { oid: '2.5.4.15', value: 'Private Organization' },
    ]);
  });

  it('passes a valid Spotify signature chained to the pinned DigiCert root', () => {
    const checks = windowsChecks(report(), anchors, 'pe', [digicert]);
    expect(checks.map(check => [check.id, check.status])).toEqual([
      ['windows.authenticode-status', 'pass'], ['windows.signer', 'pass'], ['windows.chain', 'pass'], ['windows.timestamp', 'pass'], ['windows.signtool', 'pass'],
    ]);
  });

  it('fails a hash mismatch, another signer, a chain to another root, no timestamp and a signtool failure', () => {
    const checks = windowsChecks(report({
      status: 'HashMismatch', statusMessage: 'The contents of the file may have been tampered with.',
      signer: { subject: 'CN=Someone Else, O=Someone Else, C=US', issuer: 'CN=Other CA', thumbprint: 'FF', notBefore: '2025-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
      timestamper: null,
      chain: { built: true, elements: [{ subject: 'CN=Someone Else', thumbprint: 'FF' }, { subject: 'CN=Other Root', thumbprint: '00' }], status: [] },
      signtool: { path: 'signtool.exe', exitCode: 1, output: 'SignTool Error: WinVerifyTrust returned error: 0x80096010\r\n' },
    }), anchors, 'pe', [digicert]);
    expect(checks.every(check => check.status === 'fail')).toBe(true);
  });

  it('checks a Store package against the pinned publisher and the Microsoft root', () => {
    const store = report({
      signer: { subject: 'CN=453637B3-4E12-4CDF-B0D3-2A3C863BF6EF', issuer: 'CN=Microsoft Marketplace CA G 026', thumbprint: 'AA', notBefore: '2026-01-01T00:00:00Z', notAfter: '2027-01-01T00:00:00Z' },
      chain: { built: true, elements: [{ subject: 'CN=453637B3-4E12-4CDF-B0D3-2A3C863BF6EF', thumbprint: 'AA' }, { subject: 'CN=Microsoft Root Certificate Authority 2011', thumbprint: microsoft }], status: [] },
    });
    expect(windowsChecks(store, anchors, 'appx', [microsoft]).find(check => check.id === 'windows.signer')?.status).toBe('pass');
    expect(windowsChecks(store, anchors, 'pe', [digicert]).find(check => check.id === 'windows.signer')?.status).toBe('fail');
  });

  it('rejects a report of another shape', () => {
    expect(WindowsReport.safeParse({ status: 'Valid' }).success).toBe(false);
  });
});

describe('osslsigncode output (strings from osslsigncode.c 2.x)', () => {
  const ok = 'Current PE checksum   : 099D4D1D\nSignature verification: ok\n\nTimestamp Server Signature verification: ok\nNumber of verified signatures: 1\nSucceeded\n';
  it('passes only when every signature and timestamp is ok and the verdict is Succeeded', () => {
    expect(parseOsslsigncode(ok, 0).ok).toBe(true);
    expect(parseOsslsigncode(ok.replace('Signature verification: ok', 'Signature verification: failed'), 1).ok).toBe(false);
    expect(parseOsslsigncode(ok.replace('Timestamp Server Signature verification: ok', 'Timestamp Server Signature verification: failed'), 0).ok).toBe(false);
    expect(parseOsslsigncode(ok.replace('Succeeded', 'Failed'), 1).ok).toBe(false);
    expect(parseOsslsigncode('Succeeded\n', 0).ok).toBe(false);
  });
});
