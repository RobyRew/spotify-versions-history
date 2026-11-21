// @ts-check
import { createHash } from 'node:crypto';
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';
import { houseDefaults } from '@robyrew/web-config/astro';
import { themeBootstrap } from '@robyrew/web-config/theme-bootstrap';

const site = process.env.PUBLIC_SITE_URL || 'https://spotify-versions-history.robyrew.com';

// The pre-paint theme stamp is an inline script; its hash comes from the package's own string, so a
// web-config upgrade cannot leave a stale pin in the CSP.
/** @type {`sha256-${string}`} */
const bootstrapHash = `sha256-${createHash('sha256').update(themeBootstrap).digest('base64')}`;

// Server-rendered: the pages and the API read the ledger, the link-health file and the latest
// verification report in memory (web/src/lib/data.ts) and refresh them in the background.
export default defineConfig({
  ...houseDefaults,
  site,
  output: 'server',
  adapter: node({ mode: 'standalone', bodySizeLimit: 64 * 1024 }),
  security: {
    checkOrigin: true,
    allowedDomains: [{ protocol: new URL(site).protocol.replace(':', ''), hostname: new URL(site).hostname }],
    csp: {
      directives: [
        "default-src 'self'",
        "img-src 'self' data:",
        "font-src 'self'",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: { hashes: [bootstrapHash] },
    },
  },
  server: { port: 4355 },
  markdown: { syntaxHighlight: false },
  vite: {
    plugins: [tailwindcss()],
    build: { target: 'safari16', cssTarget: 'safari16' },
    // The site imports the ledger and sensor modules from the repository root (../lib, ../sensors).
    server: { fs: { allow: ['..'] } },
  },
});
