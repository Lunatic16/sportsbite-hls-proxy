# syntax=docker/dockerfile:1

# ── Stage 1: install every dependency (dev deps included — next build needs them) ──
# NOTE: `npm ci` requires package-lock.json (committed). bun.lock is for local dev.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── Stage 2: build the standalone Next.js server ──────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: minimal runtime — official node image, no binary-copy tricks ─────
# (the old image copied the node binary from a floating tag onto bare alpine,
#  which broke whenever the base was rebuilt — the #1 "container fails often"
#  cause)
#
# Node 22 is REQUIRED, not 20: undici 8 (engines: node >=22.19) calls
# node:zlib.createZstdDecompress (Node >=22.15) unguarded at module scope, so
# on Node 20 `next build` dies during "Collecting page data" for /api/import
# with: TypeError: Cannot read properties of undefined (reading 'bind').
FROM node:22-alpine AS runtime
WORKDIR /app

LABEL org.opencontainers.image.title="iptv-stream-proxy" \
      org.opencontainers.image.description="Self-hosted IPTV web viewer + HLS proxy + dynamic M3U playlist generator" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/app/data \
    NEXT_TELEMETRY_DISABLED=1

# tini = proper PID 1 signal handling; su-exec = privilege drop in the
# entrypoint; ca-certificates for TLS upstreams.
# The official node images ship a built-in `node` user/group at uid/gid 1000.
# REUSE it — creating another gid-1000 group collides ("addgroup: gid '1000'
# in use" on current node:22-alpine, the #2 recurring "container fails often"
# cause).
RUN apk add --no-cache tini su-exec libstdc++ libgcc ca-certificates \
    && mkdir -p /app/data \
    && chown -R node:node /app

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node channels.example.json ./

# No USER directive on purpose: the entrypoint starts as root ONLY to fix the
# ownership of the data dir (Docker creates missing bind-mount host dirs as
# root:root — the #1 cause of "Could not load channels / EACCES" on first
# run), then execs the server as uid 1000 via su-exec. The server itself
# never runs as root, and `docker run --user 1000:1000` still works (the fix
# is skipped when already unprivileged).
#
# Robustness against lost exec bits (the #3 recurring container failure):
# - plain COPY + RUN chmod instead of COPY --chmod (which some legacy
#   builders silently drop — the kernel then refuses execve even for root:
#   CAP_DAC_OVERRIDE only overrides execute when at least one x bit is set)
# - the ENTRYPOINT runs it through `sh`, so even a mode-644 script executes
COPY --chown=node:node docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0755 /app/docker-entrypoint.sh

EXPOSE 3000

# Node-based healthcheck: no busybox-wget reliance, explicit loopback IP,
# respects the PORT env var.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Chain: tini (PID 1, signals) -> sh (immune to a lost exec bit on the
# script) -> entrypoint (chown data dir once) -> su-exec (drop to PUID:PGID,
# default 1000:1000) -> node server.js.
ENTRYPOINT ["/sbin/tini", "--", "sh", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
