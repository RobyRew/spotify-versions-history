/**
 * Windows' own signature checks, on a Windows host (GitHub's windows-latest runners): PowerShell's
 * Get-AuthenticodeSignature with the signer's chain built by .NET, and signtool verify /pa from the
 * Windows SDK. The script prints one JSON document whose shape the parser checks with zod; any
 * other shape is a failure. The sample outputs in the tests are hand-written after .NET's formats.
 */
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { loadCertificates, type TrustAnchors } from '../../lib/trust.ts';
import { parseDistinguishedName, sameAttributes } from '../lib/cms.ts';
import { fail, pass, skip, type Check } from './types.ts';

const IDS = ['windows.authenticode-status', 'windows.signer', 'windows.chain', 'windows.timestamp', 'windows.signtool'] as const;

/** Reads the file path from SVH_FILE, so no path is ever interpolated into the script. */
export const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$path = $env:SVH_FILE
$sig = Get-AuthenticodeSignature -LiteralPath $path
$signer = $null
$chain = $null
if ($sig.SignerCertificate) {
  $c = $sig.SignerCertificate
  $signer = [ordered]@{ subject = $c.Subject; issuer = $c.Issuer; thumbprint = $c.Thumbprint; notBefore = $c.NotBefore.ToUniversalTime().ToString('o'); notAfter = $c.NotAfter.ToUniversalTime().ToString('o') }
  $x = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
  $x.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $built = $x.Build($c)
  $elements = @($x.ChainElements | ForEach-Object { [ordered]@{ subject = $_.Certificate.Subject; thumbprint = $_.Certificate.Thumbprint } })
  $statuses = @($x.ChainStatus | ForEach-Object { [string]$_.Status })
  $chain = [ordered]@{ built = $built; elements = $elements; status = $statuses }
}
$timestamper = $null
if ($sig.TimeStamperCertificate) { $timestamper = [ordered]@{ subject = $sig.TimeStamperCertificate.Subject; issuer = $sig.TimeStamperCertificate.Issuer } }
$signtool = $null
$tool = Get-ChildItem -Path "$($env:ProgramFiles + ' (x86)')\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
if ($tool) {
  $ErrorActionPreference = 'Continue'
  $out = & $tool.FullName verify /pa /all /v $path 2>&1 | Out-String
  $signtool = [ordered]@{ path = $tool.FullName; exitCode = $LASTEXITCODE; output = $out }
}
[ordered]@{ status = [string]$sig.Status; statusMessage = [string]$sig.StatusMessage; signatureType = [string]$sig.SignatureType; signer = $signer; timestamper = $timestamper; chain = $chain; signtool = $signtool } | ConvertTo-Json -Depth 6 -Compress
`;

const Certificate = z.object({ subject: z.string(), issuer: z.string(), thumbprint: z.string(), notBefore: z.string(), notAfter: z.string() });
export const WindowsReport = z.object({
  status: z.string(),
  statusMessage: z.string(),
  signatureType: z.string(),
  signer: Certificate.nullable(),
  timestamper: z.object({ subject: z.string(), issuer: z.string() }).nullable(),
  chain: z.object({
    built: z.boolean(),
    elements: z.array(z.object({ subject: z.string(), thumbprint: z.string() })),
    status: z.array(z.string()),
  }).nullable(),
  signtool: z.object({ path: z.string(), exitCode: z.number(), output: z.string() }).nullable(),
});
export type WindowsReport = z.infer<typeof WindowsReport>;

/** .NET writes subjects as "CN=Spotify AB, O=..., SERIALNUMBER=..., OID.2.5.4.15=Private Organization", quoting values with commas. */
export function dotnetName(text: string): { oid: string; value: string }[] {
  return parseDistinguishedName(text.replace(/\bOID\.(\d+(?:\.\d+)+)=/g, '$1='))
    .map(attribute => ({ oid: attribute.oid, value: attribute.value.replace(/^"(.*)"$/, '$1').replaceAll('""', '"') }));
}

/** Rows for one report: pe files against the Authenticode anchors, appx against the Store publisher. */
export function windowsChecks(report: WindowsReport, trust: TrustAnchors, kind: 'pe' | 'appx', rootThumbprints: readonly string[]): Check[] {
  const verifier = 'Get-AuthenticodeSignature';
  const checks: Check[] = [];
  checks.push(report.status === 'Valid'
    ? pass('windows.authenticode-status', verifier, `Valid (${report.signatureType})`)
    : fail('windows.authenticode-status', verifier, `${report.status}: ${report.statusMessage}`));
  if (!report.signer) {
    checks.push(fail('windows.signer', verifier, 'no signer certificate'));
  } else {
    let problem: string | null = null;
    try {
      const subject = dotnetName(report.signer.subject);
      if (kind === 'appx') {
        if (!sameAttributes(subject, parseDistinguishedName(trust.windowsStore.publisher))) problem = `expected the publisher ${trust.windowsStore.publisher}, found ${report.signer.subject}`;
      } else {
        const missing = Object.entries(trust.windows.authenticode.subject).filter(([label, value]) => {
          const [wanted] = parseDistinguishedName(`${label}=${value}`);
          return !subject.some(attribute => attribute.oid === wanted!.oid && attribute.value === value);
        });
        if (missing.length) problem = `the signer subject ${report.signer.subject} lacks ${missing.map(([label, value]) => `${label}=${value}`).join(', ')}`;
      }
    } catch (error) {
      problem = `the signer subject ${report.signer.subject} could not be read: ${(error as Error).message}`;
    }
    checks.push(problem ? fail('windows.signer', verifier, problem) : pass('windows.signer', verifier, report.signer.subject, { thumbprint: report.signer.thumbprint }));
  }
  const last = report.chain?.elements.at(-1);
  const tolerated = new Set(['NotTimeValid']); // an expired signer is valid when timestamped; the status row covers that
  const statuses = (report.chain?.status ?? []).filter(status => !tolerated.has(status));
  checks.push(last && rootThumbprints.includes(last.thumbprint.toUpperCase()) && statuses.length === 0
    ? pass('windows.chain', '.NET X509Chain', report.chain!.elements.map(element => element.subject).join(' <- '))
    : fail('windows.chain', '.NET X509Chain', `expected a chain to a pinned root (${rootThumbprints.join(', ')}), found ${last ? `${last.subject} ${last.thumbprint}` : 'none'}${statuses.length ? `, status ${statuses.join(', ')}` : ''}`));
  checks.push(report.timestamper
    ? pass('windows.timestamp', verifier, report.timestamper.subject)
    : fail('windows.timestamp', verifier, 'no timestamp'));
  if (!report.signtool) checks.push(skip('windows.signtool', 'signtool', 'signtool.exe was not found under Windows Kits\\10\\bin'));
  else {
    const ok = report.signtool.exitCode === 0 && /Successfully verified/.test(report.signtool.output);
    checks.push(ok
      ? pass('windows.signtool', 'signtool verify /pa', 'Successfully verified', { path: report.signtool.path })
      : fail('windows.signtool', 'signtool verify /pa', `exit ${report.signtool.exitCode}: ${report.signtool.output.trim().split('\n').slice(-3).join(' | ')}`));
  }
  return checks;
}

const runPowerShell = (file: string): Promise<{ code: number; stdout: string; stderr: string; missing: boolean }> => new Promise(resolve => {
  const attempt = (shell: string, fallback: string | null) => {
    execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], { env: { ...process.env, SVH_FILE: file }, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') { if (fallback) attempt(fallback, null); else resolve({ code: 1, stdout, stderr, missing: true }); return; }
      resolve({ code: error ? 1 : 0, stdout, stderr, missing: false });
    });
  };
  attempt('pwsh', 'powershell.exe');
});

export async function verifyWindowsNative(file: string, trust: TrustAnchors, kind: 'pe' | 'appx'): Promise<Check[]> {
  if (process.platform !== 'win32') return IDS.map(id => skip(id, 'Windows tools', 'Get-AuthenticodeSignature and signtool run on the Windows host'));
  const result = await runPowerShell(file);
  if (result.missing) return IDS.map(id => fail(id, 'PowerShell', 'neither pwsh nor powershell.exe is available'));
  let report: WindowsReport;
  try { report = WindowsReport.parse(JSON.parse(result.stdout.trim())); }
  catch (error) { return IDS.map(id => fail(id, 'PowerShell', `unexpected output (exit ${result.code}): ${(error as Error).message.slice(0, 200)} ${result.stderr.trim().slice(0, 300)}`)); }
  const roots = await loadCertificates(trust, kind === 'pe' ? trust.windows.authenticode.roots : trust.windowsStore.signingRoots);
  return windowsChecks(report, trust, kind, roots.map(root => root.fingerprint.replaceAll(':', '').toUpperCase()));
}

