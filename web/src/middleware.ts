import { defineMiddleware } from 'astro:middleware';
import { securityHeaders } from '@robyrew/web-config/security-headers';

// Astro writes the CSP itself (astro.config.mjs security.csp); the other house headers come from here.
const HEADERS = securityHeaders({ csp: false });

export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  for (const [name, value] of Object.entries(HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  return response;
});
