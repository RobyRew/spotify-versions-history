/**
 * osslsigncode as a second implementation of the Authenticode and package signature checks on Linux.
 * The verdict strings come from osslsigncode.c (2.x): one "Signature verification: ok|failed" line per
 * signature, "Timestamp Server Signature verification: ok|failed", and "Succeeded" or "Failed" last.
 */
import { execFile } from 'node:child_process';
import { fail, pass, skip, type Check } from './types.ts';

const run = (args: string[]): Promise<{ code: number; output: string; missing: boolean }> => new Promise(resolve => {
  execFile('osslsigncode', args, { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    resolve({ code: error ? (missing ? 127 : 1) : 0, output: `${stdout}${stderr}`, missing });
  });
});

export function parseOsslsigncode(output: string, code: number): { ok: boolean; detail: string } {
  const lines = output.split('\n').map(line => line.trim());
  const signatures = lines.filter(line => line.startsWith('Signature verification:'));
  const timestamps = lines.filter(line => line.startsWith('Timestamp Server Signature verification:'));
  const verdict = [...lines].reverse().find(line => line === 'Succeeded' || line === 'Failed');
  const ok = code === 0 && verdict === 'Succeeded' && signatures.length > 0 && signatures.every(line => line.endsWith(': ok')) && timestamps.every(line => line.endsWith(': ok'));
  const failure = lines.find(line => /failed|error/i.test(line) && !line.startsWith('Signature verification: ok'));
  return { ok, detail: ok ? `${signatures.length} signature(s) ok${timestamps.length ? `, ${timestamps.length} timestamp(s) ok` : ''}` : `exit ${code}, ${verdict ?? 'no verdict'}${failure ? `: ${failure}` : ''}` };
}

export async function osslsigncodeVerify(file: string, caFile: string, tsaCaFile: string): Promise<Check[]> {
  const version = await run(['--version']);
  if (version.missing) return [skip('osslsigncode.verify', 'osslsigncode', 'osslsigncode is not installed on this host')];
  const verifier = version.output.split('\n')[0]?.replace(/,.*$/, '').trim() || 'osslsigncode';
  const result = await run(['verify', '-in', file, '-CAfile', caFile, '-TSA-CAfile', tsaCaFile]);
  const parsed = parseOsslsigncode(result.output, result.code);
  return [parsed.ok ? pass('osslsigncode.verify', verifier, parsed.detail) : fail('osslsigncode.verify', verifier, parsed.detail, { output: result.output.slice(-2000) })];
}
