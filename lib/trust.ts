/**
 * The identities a build must carry to be recorded as Spotify's (ledger/trust/anchors.json). Each
 * entry records when and from what it was read. A change of signer, key or package identity makes a
 * verifier fail closed until the new value is reviewed and written here.
 *
 * Root certificates are files under ledger/trust/certificates/, pinned by SHA-256; a platform names
 * the roots its signatures (and, for the Microsoft Store, its delivery service's TLS) must chain to.
 */
import { X509Certificate } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const Observed = z.strictObject({ at: z.iso.date(), from: z.string().min(1) });

export const CertificateAnchor = z.strictObject({
  /** Path of the PEM file, relative to the directory of anchors.json. */
  file: z.string().min(1),
  /** SHA-256 of the certificate's DER, upper-case hex without separators. */
  sha256: z.string().regex(/^[0-9A-F]{64}$/),
  subject: z.string().min(1),
  /** Where the certificate was downloaded from; Microsoft publishes its roots over http only. */
  source: z.url(),
  observed: Observed,
});

/** Names of entries in `certificates`. */
const Roots = z.array(z.string().min(1)).min(1);

export const TrustAnchors = z.strictObject({
  schema: z.literal(1),
  certificates: z.record(z.string().regex(/^[a-z0-9-]+$/), CertificateAnchor),
  windows: z.strictObject({
    authenticode: z.strictObject({
      /** Subject attributes the signing certificate must carry, keyed by the attribute's long name. */
      subject: z.record(z.string(), z.string()),
      issuer: z.string().min(1),
      root: z.string().min(1),
      roots: Roots,
      timestampRoots: Roots,
      observed: Observed,
    }),
  }),
  windowsStore: z.strictObject({
    productId: z.string().min(1),
    packageIdentityName: z.string().min(1),
    packageFamilyName: z.string().min(1),
    publisher: z.string().min(1),
    wuCategoryId: z.string().min(1),
    /** Roots of the package signature (AppxSignature.p7x), of its timestamp, and of fe3.delivery.mp.microsoft.com's TLS. */
    signingRoots: Roots,
    timestampRoots: Roots,
    deliveryRoots: Roots,
    observed: Observed,
  }),
  macos: z.strictObject({
    teamId: z.string().regex(/^[A-Z0-9]{10}$/),
    identifier: z.string().min(1),
    authorities: z.array(z.string().min(1)).min(1),
    observed: Observed,
  }),
  apt: z.strictObject({
    repository: z.url({ protocol: /^https$/ }),
    suites: z.array(z.string().min(1)).min(1),
    keys: z.array(z.strictObject({
      fingerprint: z.string().regex(/^[0-9A-F]{40}$/),
      file: z.string().min(1),
      uid: z.string().min(1),
      created: z.iso.date(),
      source: z.url({ protocol: /^https$/ }),
    })).min(1),
  }),
  snap: z.strictObject({
    name: z.string().min(1),
    snapId: z.string().min(1),
    developerId: z.string().min(1),
    authority: z.string().min(1),
    /** The account-key snapd trusts as the root of every Canonical assertion (asserts/sysdb/trusted.go). */
    rootKey: z.strictObject({
      sha3_384: z.string().regex(/^[A-Za-z0-9_-]{64}$/),
      file: z.string().min(1),
      source: z.url({ protocol: /^https$/ }),
    }),
    observed: Observed,
  }),
  android: z.strictObject({
    package: z.string().min(1),
    signerSha256: z.array(z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)).min(1),
    observed: Observed,
  }),
  ios: z.strictObject({
    trackId: z.int().positive(),
    bundleId: z.string().min(1),
    observed: Observed,
  }),
}).superRefine((anchors, ctx) => {
  const references: [string[], (string | number)[]][] = [
    [anchors.windows.authenticode.roots, ['windows', 'authenticode', 'roots']],
    [anchors.windows.authenticode.timestampRoots, ['windows', 'authenticode', 'timestampRoots']],
    [anchors.windowsStore.signingRoots, ['windowsStore', 'signingRoots']],
    [anchors.windowsStore.timestampRoots, ['windowsStore', 'timestampRoots']],
    [anchors.windowsStore.deliveryRoots, ['windowsStore', 'deliveryRoots']],
  ];
  for (const [names, path] of references) {
    for (const name of names) {
      if (!(name in anchors.certificates)) ctx.addIssue({ code: 'custom', path, message: `no certificate named "${name}"` });
    }
  }
});

export type TrustAnchors = z.infer<typeof TrustAnchors>;
export type CertificateAnchor = z.infer<typeof CertificateAnchor>;

export const TRUST_PATH = 'ledger/trust/anchors.json';
/** The directory anchors.json and the files it names live in. */
export const TRUST_DIRECTORY = dirname(TRUST_PATH);

export async function loadTrust(path = TRUST_PATH): Promise<TrustAnchors> {
  return TrustAnchors.parse(JSON.parse(await readFile(path, 'utf8')));
}

/** SHA-256 of a certificate's DER in the anchors' notation: upper-case hex, no separators. */
export function certificateSha256(certificate: X509Certificate): string {
  return certificate.fingerprint256.replaceAll(':', '').toUpperCase();
}

/**
 * The named root certificates, read from their files and checked against the pinned SHA-256, in the
 * order given. A file whose fingerprint differs from anchors.json is an error, never a fallback.
 */
export async function loadCertificates(trust: TrustAnchors, names: readonly string[], directory = TRUST_DIRECTORY): Promise<X509Certificate[]> {
  const certificates: X509Certificate[] = [];
  for (const name of names) {
    const anchor = trust.certificates[name];
    if (!anchor) throw new Error(`No certificate named "${name}" in the trust anchors`);
    const certificate = new X509Certificate(await readFile(join(directory, anchor.file)));
    const actual = certificateSha256(certificate);
    if (actual !== anchor.sha256) throw new Error(`${anchor.file} has SHA-256 ${actual}, not the pinned ${anchor.sha256}`);
    certificates.push(certificate);
  }
  return certificates;
}
