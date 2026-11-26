import { defineMiddleware } from 'astro:middleware';
import { securityHeaders } from '@robyrew/web-config/security-headers';
import { DEVICE_HINT_HEADERS } from './lib/device.ts';

// Astro writes the CSP itself (astro.config.mjs security.csp); the other house headers come from here.
const HEADERS = securityHeaders({ csp: false });

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [name, value] of Object.entries(HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  // Pages put the visitor's system first (src/lib/device.ts): ask Chromium for the architecture hints
  // on later requests and keep any cache per system.
  if (response.headers.get('content-type')?.startsWith('text/html')) {
    for (const [name, value] of Object.entries(DEVICE_HINT_HEADERS)) response.headers.set(name, value);
  }
  return response;
});
