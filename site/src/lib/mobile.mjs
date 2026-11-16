export const STORE_PRODUCT = '9NCBCSZSJRSB';
export const STORE_URL = `https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/${STORE_PRODUCT}?market=US&locale=en-us&deviceFamily=Windows.Desktop`;
export const ITUNES_URL = 'https://itunes.apple.com/lookup?bundleId=com.spotify.client&country=us';

/** Public iTunes lookup. One bundle covers iPhone and iPad. No IPA URL is in this payload. */
export function parseItunesLookup(payload) {
  const app = payload?.results?.find(row => row?.bundleId === 'com.spotify.client');
  if (!app || typeof app.version !== 'string' || !app.version) return null;
  const listing = typeof app.trackViewUrl === 'string' ? app.trackViewUrl.split('?')[0] : 'https://apps.apple.com/app/id324684580';
  return {
    bundleId: 'com.spotify.client',
    version: app.version,
    releaseDate: typeof app.currentVersionReleaseDate === 'string' ? app.currentVersionReleaseDate : null,
    listing,
    devices: ['ios', 'ipados'],
  };
}

/**
 * Storefront product document. Microsoft often leaves Version empty and still
 * sends LastUpdateDateUtc; an empty version is stored as null, not guessed.
 */
export function parseStoreProduct(payload) {
  const body = payload?.Payload ?? payload;
  if (!body || body.PublisherName !== 'Spotify AB') return null;
  const version = typeof body.Version === 'string' && body.Version.trim() ? body.Version.trim() : null;
  return {
    productId: STORE_PRODUCT,
    title: typeof body.Title === 'string' ? body.Title : null,
    version,
    lastUpdate: typeof body.LastUpdateDateUtc === 'string' ? body.LastUpdateDateUtc : null,
    listing: `https://apps.microsoft.com/detail/${STORE_PRODUCT.toLowerCase()}`,
  };
}
