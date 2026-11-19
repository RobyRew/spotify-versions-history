/**
 * The Microsoft Store product 9NCBCSZSJRSB, read from displaycatalog without an account. Package
 * versions map to desktop builds as 1.<minor·100+patch>.<build>.0 (lib/versions.ts). The catalog
 * carries no download URL: the capture asks the Store's delivery service (FE3) for a short-lived one.
 */
import type { TrustAnchors } from '../../lib/trust.ts';
import { storeToDesktop, unpackPackageVersion } from '../../lib/versions.ts';
import { getJson } from '../lib/http.ts';
import type { Arch, Detection, Format, Sensor } from '../types.ts';

export function storeCatalogUrl(productId: string): string {
  return `https://displaycatalog.mp.microsoft.com/v7.0/products/${productId}?market=US&languages=en-US&fieldsTemplate=Details`;
}

const FORMATS: Readonly<Record<string, Format>> = { appx: 'appx', appxbundle: 'appxbundle', msix: 'msix', msixbundle: 'msixbundle' };

interface StorePackage {
  PackageFullName?: string;
  PackageFamilyName?: string;
  PackageId?: string;
  ContentId?: string;
  Architectures?: string[];
  Version?: string | number;
  PackageFormat?: string;
  Hash?: string;
  HashAlgorithm?: string;
  MaxDownloadSizeInBytes?: number;
}

export function storeDetections(catalog: unknown, trust: TrustAnchors): { reading: Record<string, unknown>; detections: Detection[]; notes: string[] } {
  const anchor = trust.windowsStore;
  const product = (catalog as { Product?: Record<string, any> }).Product;
  if (!product || product.ProductId !== anchor.productId) throw new Error(`displaycatalog answered for ${product?.ProductId}, not ${anchor.productId}`);
  const properties = product.Properties ?? {};
  if (properties.PackageFamilyName !== anchor.packageFamilyName || properties.PublisherCertificateName !== anchor.publisher) {
    throw new Error(`Store identity ${properties.PackageFamilyName} / ${properties.PublisherCertificateName} is not the pinned ${anchor.packageFamilyName} / ${anchor.publisher}`);
  }
  const name = new RegExp(`^${anchor.packageIdentityName.replace(/\./g, '\\.')}_(\\d+\\.\\d+\\.\\d+\\.\\d+)_(x64|x86|arm64)__([a-z0-9]+)$`);
  const seen = new Set<string>();
  const detections: Detection[] = [];
  const notes: string[] = [];
  for (const availability of product.DisplaySkuAvailabilities ?? []) {
    const sku = availability.Sku ?? {};
    const fulfillment = sku.Properties?.FulfillmentData ?? {};
    for (const pkg of (sku.Properties?.Packages ?? []) as StorePackage[]) {
      const fullName = pkg.PackageFullName ?? '';
      if (seen.has(fullName)) continue;
      seen.add(fullName);
      const match = name.exec(fullName);
      const desktop = match ? storeToDesktop(match[1]!) : null;
      const format = FORMATS[(pkg.PackageFormat ?? '').toLowerCase()];
      if (!match || !desktop || !format || `${anchor.packageIdentityName}_${match[3]}` !== anchor.packageFamilyName) {
        notes.push(`store: skipped package ${fullName} (${pkg.PackageFormat})`);
        continue;
      }
      if (pkg.Version !== undefined && unpackPackageVersion(pkg.Version) !== match[1]) {
        notes.push(`store: ${fullName} names ${match[1]} but its packed version is ${unpackPackageVersion(pkg.Version)}`);
        continue;
      }
      detections.push({
        sensor: 'store', product: 'desktop',
        version: desktop, fullVersion: null,
        platform: 'windows-store', arch: match[2] as Arch, format,
        url: null, lifetime: 'fetch-on-demand',
        size: Number.isSafeInteger(pkg.MaxDownloadSizeInBytes) ? pkg.MaxDownloadSizeInBytes! : null,
        claimed: pkg.HashAlgorithm?.toUpperCase() === 'SHA256' && pkg.Hash ? { sha256: Buffer.from(pkg.Hash, 'base64').toString('hex') } : {},
        meta: {
          packageFullName: fullName, storeVersion: match[1]!, packageId: pkg.PackageId ?? null, contentId: pkg.ContentId ?? null,
          skuId: sku.SkuId ?? null, wuCategoryId: fulfillment.WuCategoryId ?? anchor.wuCategoryId,
        },
      });
    }
  }
  const packages = detections.map(detection => ({ packageFullName: detection.meta.packageFullName, sha256: detection.claimed.sha256 ?? null, size: detection.size }));
  return { reading: { lastModified: product.LastModifiedDate ?? null, packages }, detections, notes };
}

export const store: Sensor = {
  id: 'store',
  describe: 'The Microsoft Store listing 9NCBCSZSJRSB (displaycatalog)',
  async detect({ fetch, trust }) {
    const catalog = await getJson(fetch, storeCatalogUrl(trust.windowsStore.productId));
    const { reading, detections, notes } = storeDetections(catalog, trust);
    return { state: reading, detections, notes };
  },
};
