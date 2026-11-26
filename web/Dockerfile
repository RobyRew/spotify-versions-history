# syntax=docker/dockerfile:1.10
# The archive's website. Build context: the repository root, because the site imports the ledger,
# view and sensor-schema modules from lib/ and sensors/ (bundled into dist at build time).
#
#   docker build -f web/Dockerfile .
# ─────────────────────────────────────────────────────────────────────────────
# Build — Node 26. SQLite is Node's built-in node:sqlite: no native addon, no compiler.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS build
WORKDIR /app

# zod for the modules in lib/ (resolved from the repository root while bundling).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# --ignore-scripts: nothing here needs an install script, and with scripts npm "prepares" the git
# dependency @robyrew/astro-logto by installing its dev dependencies.
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci --ignore-scripts --no-audit --no-fund

COPY tsconfig.json ./
COPY lib ./lib
COPY sensors ./sensors
COPY web ./web

# Read at build time for the CSP (form-action names Logto, img-src the avatar origins) and the
# canonical URL; the defaults are production's.
ARG PUBLIC_SITE_URL=https://version-history.spotify.robyrew.com
ARG LOGTO_ENDPOINT=https://auth.robyrew.com
ARG AVATAR_ORIGINS=https://id.robyrew.com
# Type checks run in CI (npm run check); the image only builds.
RUN cd web && PUBLIC_SITE_URL="$PUBLIC_SITE_URL" LOGTO_ENDPOINT="$LOGTO_ENDPOINT" AVATAR_ORIGINS="$AVATAR_ORIGINS" npx astro build

# Keep only runtime dependencies.
RUN cd web && npm prune --omit=dev --ignore-scripts

# ─────────────────────────────────────────────────────────────────────────────
# Runtime — the @astrojs/node standalone server, non-root.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:26-alpine AS runtime
WORKDIR /app/web

# LEGACY_DATA_URL / HEALTH_URL / VERIFICATION_URL and the LOGTO_* variables come from the Dokploy
# environment (web/README.md). The data files copied below are the fallback when GitHub cannot be
# reached at start.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    DATA_DIR=/app/data \
    LEGACY_DATA_DIR=/app/site/data \
    NODE_OPTIONS=--max-old-space-size=128

# Fixed ids, so a volume prepared on the host can be owned by them.
RUN addgroup -S -g 101 app && adduser -S -u 100 -G app app

COPY --from=build --chown=app:app /app/web/dist ./dist
COPY --from=build --chown=app:app /app/web/node_modules ./node_modules
COPY --from=build --chown=app:app /app/web/package.json ./package.json
COPY --chown=app:app site/data/catalog.json site/data/official.json site/data/mobile.json /app/site/data/

# archive.db (people who signed in, likes, reactions, comments, reports, download counts, sessions)
# and snapshot/archive.db live here. Mount the named volume spotify-versions-history-data on this
# path in Dokploy, or every redeploy starts empty.
RUN mkdir -p /app/data && chown app:app /app/data

USER app
EXPOSE 4321

# No exec healthcheck on vps01: exec probes leaked pids and kernel memory there (2026-09). The host's
# site probe calls /healthz instead.
HEALTHCHECK NONE

CMD ["node", "./dist/server/entry.mjs"]
