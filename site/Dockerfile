# Build from the repository root:
#   docker build -f site/Dockerfile .
FROM node:24-bookworm-slim
WORKDIR /app
COPY site/package.json site/package-lock.json ./site/
RUN npm ci --prefix site
COPY site ./site
ENV ARCHIVE_TARGET=server
RUN npm run build --prefix site
ENV NODE_ENV=production
ENV ARCHIVE_DB=/data/archive.sqlite
ENV PUBLIC_SITE_URL=https://spotify-versions-history.robyrew.com
WORKDIR /app/site
EXPOSE 4321
CMD ["node", "--experimental-sqlite", "--import", "tsx", "server/main.mjs"]
