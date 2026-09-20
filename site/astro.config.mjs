import { defineConfig } from 'astro/config';
export default defineConfig({
  site: 'https://robyrew.github.io',
  base: '/spotify-versions-history',
  output: 'static',
  trailingSlash: 'always',
  devToolbar: { enabled: false },
});
