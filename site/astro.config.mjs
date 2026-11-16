import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import { houseDefaults } from '@robyrew/web-config/astro';

// Pages stays a static site under /spotify-versions-history/. The VPS build
// (ARCHIVE_TARGET=server) is the same pages at the domain root; the node
// process in server/main.mjs serves that dist and the write API.
const server = process.env.ARCHIVE_TARGET === 'server';

export default defineConfig({
  ...houseDefaults,
  site: server ? 'https://spotify-versions-history.robyrew.com' : 'https://robyrew.github.io',
  base: server ? '/' : '/spotify-versions-history',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
  vite: {
    plugins: [tailwindcss()],
  },
});
