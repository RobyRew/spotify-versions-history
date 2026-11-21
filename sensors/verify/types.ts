/**
 * Results of the checks a captured file goes through before it may be recorded as Spotify's build.
 *
 * Every verifier returns Check rows and never throws for a file that fails a check: a failure is a
 * row with status "fail" and a detail saying what was expected and what was found. A verifier throws
 * only when it cannot run at all (a missing tool on this host is a "skip" row, not a throw).
 */

export type CheckStatus = 'pass' | 'fail' | 'skip';

export interface Check {
  /**
   * Stable dotted id, "<family>.<aspect>": e.g. "authenticode.image-digest", "authenticode.chain",
   * "authenticode.signer", "authenticode.timestamp", "apt.inrelease-signature", "digest.sha256".
   */
  id: string;
  status: CheckStatus;
  /** One line; for a failure, what was expected and what was found. */
  detail: string;
  /** What ran the check, with its version: "svh-authenticode/1", "osslsigncode 2.7", "codesign (macOS 15.7)". */
  verifier: string;
  /** Values worth keeping in the report: signer subject, chain subjects, timestamp, tool output excerpts. */
  data?: Record<string, unknown>;
}

/**
 * The strongest claim a file's checks support, as the site shows it:
 *  - signed: the platform signature verifies and chains to a pinned root with the pinned signer;
 *  - spotify-digest: the file's hash equals the one Spotify's update service named;
 *  - store-digest: the hash equals one a distribution store states (Microsoft, Canonical, Spotify's apt index);
 *  - third-party-digest: the hash equals one a package manager states (winget, Scoop, Chocolatey);
 *  - unverified: none of the above.
 */
export type VerificationLevel = 'signed' | 'spotify-digest' | 'store-digest' | 'third-party-digest' | 'unverified';

export const pass = (id: string, verifier: string, detail: string, data?: Record<string, unknown>): Check =>
  ({ id, status: 'pass', detail, verifier, ...(data ? { data } : {}) });
export const fail = (id: string, verifier: string, detail: string, data?: Record<string, unknown>): Check =>
  ({ id, status: 'fail', detail, verifier, ...(data ? { data } : {}) });
export const skip = (id: string, verifier: string, detail: string, data?: Record<string, unknown>): Check =>
  ({ id, status: 'skip', detail, verifier, ...(data ? { data } : {}) });
