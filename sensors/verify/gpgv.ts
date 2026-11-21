/**
 * gpgv as a second implementation of the apt InRelease check. Ubuntu runners ship it; where it is
 * missing the check is a skip row. gpgv's status output (--status-fd) is read instead of its prose.
 */
import { execFile } from 'node:child_process';
import { fail, pass, skip, type Check } from './types.ts';

const run = (command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; missing: boolean }> =>
  new Promise(resolve => {
    execFile(command, args, { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const missing = (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout, stderr, missing });
    });
  });

/** "[GNUPG:] VALIDSIG <fingerprint> ..." lines of gpgv's status output. */
export function parseGpgvStatus(status: string): { goodsig: boolean; validsig: string[]; badsig: boolean } {
  const lines = status.split('\n');
  return {
    goodsig: lines.some(line => line.startsWith('[GNUPG:] GOODSIG ')),
    validsig: lines.filter(line => line.startsWith('[GNUPG:] VALIDSIG ')).map(line => line.split(' ')[2] ?? ''),
    badsig: lines.some(line => /^\[GNUPG:\] (BADSIG|ERRSIG|EXPKEYSIG|REVKEYSIG|NO_PUBKEY) /.test(line)),
  };
}

export async function gpgvVerify(inReleaseFile: string, keyringFile: string): Promise<Check[]> {
  const version = await run('gpgv', ['--version']);
  if (version.missing) return [skip('gpgv.inrelease', 'gpgv', 'gpgv is not installed on this host')];
  const verifier = `gpgv ${/gpgv \(GnuPG\) (\S+)/.exec(version.stdout)?.[1] ?? '?'}`;
  const result = await run('gpgv', ['--status-fd', '1', '--keyring', keyringFile, inReleaseFile]);
  const status = parseGpgvStatus(result.stdout);
  return result.code === 0 && status.goodsig && status.validsig.length > 0 && !status.badsig
    ? [pass('gpgv.inrelease', verifier, `good signature, VALIDSIG ${status.validsig.join(', ')}`, { fingerprints: status.validsig })]
    : [fail('gpgv.inrelease', verifier, `exit ${result.code}: ${(result.stderr || result.stdout).trim().split('\n').slice(-3).join(' | ')}`)];
}
