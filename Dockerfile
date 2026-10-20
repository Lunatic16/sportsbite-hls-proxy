# syntax=docker/dockerfile:1

# ── Stage 1: full dependency install (layer-cached) ──────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── Stage 2: compile server TS + bundle web UI (hls.js inlined) ──────────────
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY web ./web
COPY scripts ./scripts
RUN npm run build

# ── Stage 3: production-only dependencies ────────────────────────────────────
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ── Stage 4: minimal runtime ─────────────────────────────────────────────────
# Bare alpine + the node binary from node:20-alpine: keeps the image ~150 MB
# (a full node:20-alpine runtime would carry ~60 MB more).
FROM alpine:3.20 AS runtime

LABEL org.opencontainers.image.title="sportsbite-hls-proxy" \
      org.opencontainers.image.description="Self-hosted Sportsbite IPTV web viewer + HLS proxy + dynamic M3U8 playlist generator" \
      org.opencontainers.image.source="https://localhost/sportsbite-hls-proxy" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="sportsbite-hls-proxy"

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

WORKDIR /app

# Node needs libstdc++/libgcc; ca-certificates for TLS; tini for PID-1 signal
# handling (also fine without `docker run --init`).
RUN apk add --no-cache tini libstdc++ libgcc ca-certificates \
    && addgroup -g 1000 -S node \
    && adduser -S -u 1000 -G node -h /app node \
    && mkdir -p /app/data \
    && chown -R node:node /app

COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node channels.example.json ./
COPY --from=node:20-alpine --chown=node:node /usr/local/bin/node /usr/local/bin/node

USER node
EXPOSE 3000

# busybox wget hits 127.0.0.1 explicitly (localhost can resolve to ::1 first).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
