/**
 * The identities a build must carry to be recorded as Spotify's (ledger/trust/anchors.json). Each
 * entry records when and from what it was read. A change of signer, key or package identity makes a
 * verifier fail closed until the new value is reviewed and written here.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const Observed = z.strictObject({ at: z.iso.date(), from: z.string().min(1) });

export const TrustAnchors = z.strictObject({
  schema: z.literal(1),
  windows: z.strictObject({
    authenticode: z.strictObject({
      subject: z.record(z.string(), z.string()),
      issuer: z.string().min(1),
      root: z.string().min(1),
      observed: Observed,
    }),
  }),
  windowsStore: z.strictObject({
    productId: z.string().min(1),
    packageIdentityName: z.string().min(1),
    packageFamilyName: z.string().min(1),
    publisher: z.string().min(1),
    wuCategoryId: z.string().min(1),
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
});

export type TrustAnchors = z.infer<typeof TrustAnchors>;

export const TRUST_PATH = 'ledger/trust/anchors.json';

export async function loadTrust(path = TRUST_PATH): Promise<TrustAnchors> {
  return TrustAnchors.parse(JSON.parse(await readFile(path, 'utf8')));
}
