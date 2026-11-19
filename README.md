<div align="center">

# 🏟️ sportsbite-hls-proxy

**Self-hosted IPTV web viewer · HLS proxy · dynamic M3U8 playlist generator**

[![CI](https://github.com/Lunatic16/sportsbite-hls-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/Lunatic16/sportsbite-hls-proxy/actions/workflows/ci.yml)
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white)](#-quick-start)
[![Next.js](https://img.shields.io/badge/next.js-16-black?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![React](https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=white)](https://react.dev)
[![Node.js](https://img.shields.io/badge/node-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · shadcn/ui · hls.js

</div>

Plays channels in the browser with **hls.js** and serves **signed proxy URLs** that any IPTV app — VLC, TiviMate, IPTVnator, Kodi — can consume over your LAN. It keeps working even when the origin requires custom headers, blocks CORS, rotates short-lived segment tokens, or smuggles MPEG-TS through an image CDN.

> 🔄 **v2 — full rewrite.** The old Fastify + hand-rolled vanilla-JS app was rebuilt on **Next.js 16**: the backend is now App Router route handlers (same proxy core, hardened and unit-tested), the UI is a proper React 19 + shadcn/ui application, and the Docker setup was rebuilt from scratch to fix the recurring "container fails" issues (see [🚀 Quick start](#-quick-start)).

## ✨ Highlights

- 🌐 **A real web app, not a hand-rolled page** — rebuilt viewer on React 19 + shadcn/ui: searchable channel sidebar with group / online filters and live status dots, an HLS player with quality selector, auto-hiding controls, keyboard-first UX, and error overlays that surface the server's *actual* failure message
- 📡 **Real HLS proxy** — master & media playlists, AES-128/SAMPLE-AES keys, fMP4 init segments, LL-HLS parts, subtitles. Segments are **streamed, never fully buffered**
- 🧩 **Pluggable resolvers** — `static`, `m3u-source`, plus built-in `sportsbite` (the `247-` family) and `matchora` (the `xm-` family) resolvers needing nothing but a browser User-Agent; register your own via `registerResolver()`
- 📥 **Channels load themselves** — at startup the app imports the live sportsbite catalog (`https://sportsbite.org/channels`, ~360 channels) automatically; point `CHANNELS_IMPORT_URL` at any catalog/M3U/JSON source or switch it off
- 📋 **Dynamic M3U8 playlist** — `/playlist.m3u8` with `?group=`, `?search=`, `?format=m3u|m3u8`, `?download=1`; entries always point at *your* server, never at expiring upstream URLs
- 🩺 **Status checks built in** — one click probes every channel (playlist + first segment bytes) with bounded concurrency, persists online/offline to `channels.json` and drives the sidebar's Online filter; the same probe powers `POST /api/check` and the `npm run check` CLI
- 🔗 **Share & export panel** — live/M3U8/direct URLs, expiry countdown + refresh, VLC & MPV commands, QR codes, per-channel rotating share tokens
- 🥸 **timst unwrapping** — TikTok-CDN-disguised MPEG-TS detected and decoded per response, transparently
- 🔒 **Secure by default** — SSRF guard with DNS-rebinding protection, HMAC-signed proxy URLs, per-channel share tokens, secrets redacted from logs
- 🐳 **Docker-native** — multi-stage build, root entrypoint that auto-fixes data ownership then drops to an unprivileged user, read-only rootfs, minimal capability set, tini init, Node-based healthcheck, optional Caddy auto-HTTPS

<details>
<summary>📖 <strong>Full feature tour</strong></summary>

- **HLS proxy** — master playlists, media playlists, AES-128/SAMPLE-AES keys, fMP4 init segments, LL-HLS parts/preload-hints, subtitles. Relative URIs are resolved against the **final** (post-redirect) upstream URL. Segments are **streamed, never fully buffered** (decoded `timst` segments are the one deliberate exception — they must be reassembled).
- **Backend = Next.js App Router handlers** — every route (`/stream/:id`, `/proxy/*`, `/api/*`) is a route handler marked `runtime = 'nodejs'` / `dynamic = 'force-dynamic'`. Config (zod-validated env), the channel store, the resolver registry and caches are singletons on `globalThis`, so all route bundles share exactly one instance instead of duplicating state per bundle.
- **Pluggable resolvers** — `static` (fixed URL), `m3u-source` (looks the URL up in a source playlist at play time), and custom implementations. The built-in `sportsbite` resolver maps `247-`/`t247-`/`cv-` prefixes to `https://sportsbite.org/{247,t247,cv}/<slug>`; the built-in `matchora` resolver resolves `xm-<digits>` channels through sportsbite's matchora embed chain. To add your own scraper/token resolver, implement the `Resolver` interface from `src/server/resolvers/types.ts` and register it in `src/server/resolvers/index.ts` via `registerResolver('name', impl)` — return `{ url, headers, expiresAt }`.
- **Retry contract** — stream entry points re-resolve expired upstream URLs on every request; if the upstream answers 403/404/410 (stale token), the cached resolution is invalidated, the resolver runs again and the fetch is retried exactly once. Segment/key proxy URLs are re-issued on every playlist refresh rather than carrying an expiry of their own.
- **Status probes** — `checkChannels()` resolves the channel, fetches the playlist and HEADs the first segment within `CHECK_TIMEOUT_MS`, at `CHECK_CONCURRENCY` parallelism. Results persist to `channels.json` (`status` + `lastChecked`) and render as online/offline dots in the UI. Small lists are auto-checked on first load so the Online filter works out of the box.
- **Channel bootstrap (startup auto-import)** — `src/server/channels/bootstrap.ts` runs one second after the server starts listening: it imports `CHANNELS_IMPORT_URL` (default the sportsbite catalog) with `CHANNELS_IMPORT_MODE` (`once` — first start and URL changes, tracked via `data/channels-import.json`; `always`; `off`) and `CHANNELS_IMPORT_REPLACE` (`auto` — replace only while `channels.json` is still the untouched example seed, `true`, `false`). A failed import logs a warning and keeps the old list; it retries on the next start because no marker is written. The import runs in the background and never delays boot.
- **Dynamic M3U8 playlist** — `GET /playlist.m3u8` with `?group=`, `?search=`, `?format=m3u|m3u8`, `?download=1`. Entries always point at this server (`/stream/<id>.m3u8`), never at expiring upstream URLs. The base URL comes from the request `Host` (or `X-Forwarded-*` with `TRUST_PROXY`, or `PUBLIC_BASE_URL`), so LAN clients get reachable addresses.
- **Share & export panel** — per channel: a stable Live URL, the M3U8 stream URL, the raw Direct URL with an expiry countdown (from the resolver's `expiresAt`) and a Refresh button, shell-escaped VLC / MPV commands (POSIX, PowerShell, cmd.exe variants) with a Live/Direct source toggle, a QR code, and per-channel rotating share tokens with a confirmation dialog before the old links die.
- **timst unwrapping** — TikTok-CDN-disguised TS (fake RIFF/JPEG/PNG header, `TIKTIKPX` pixel-PNG with gzipped TS in the pixel data) is detected **per response** and decoded transparently. TikTok's CDN 403s any request carrying a `Referer`, so Referer/Origin are stripped for hosts matching `STRIP_REFERER_HOSTS`. The `xm-` source adds a fourth disguise — a real PNG whose `payload-NNNN` `iTXt` chunks hold per-chunk zlib streams of base64-encoded TS — decoded the same way.
- **Security** — SSRF guard (loopback / private / link-local / CGNAT / benchmark / multicast / metadata ranges blocked unless `ALLOW_PRIVATE_UPSTREAMS=true`, IPv4-mapped IPv6 and NAT64 included, DNS validated at connect time via a custom undici resolver), HMAC-signed proxy URLs that cannot be tampered with or replayed across kinds, per-channel share tokens that cannot open another channel or the admin API, sensitive headers never present in URLs, optional global `AUTH_TOKEN`, secrets redacted from logs.
- **Docker** — multi-stage build ending on the **official `node:22-alpine` image** (no binary-copy tricks from floating tags — the #1 cause of the old container randomly failing), an entrypoint that fixes `./data` ownership on first start and then drops to uid 1000 via `su-exec` (no manual `chown` ever), read-only rootfs with tmpfs `/tmp`, `cap_drop: ALL` plus only the four caps the privilege drop needs, `no-new-privileges`, tini for correct signal handling, and a Node-based healthcheck that needs no busybox tooling.

</details>

## 📑 Contents

[✨ Highlights](#-highlights) · [🚀 Quick start](#-quick-start) · [🖥️ Web UI](#-web-ui) · [📺 IPTV players](#-using-it-in-iptv-players) · [📥 Adding channels](#-adding-channels) · [⚙️ Configuration](#-configuration) · [🔗 Share panel](#-share-and-export-panel) · [🔌 API](#-api) · [🔒 Security](#-security-notes) · [🩺 Troubleshooting](#-troubleshooting) · [🛠️ Development](#-development) · [📄 License](#-license) · [🙏 Credits](#-credits)

## 🚀 Quick start

Two equal paths to the same destination — the web UI and an IPTV playlist at `http://<your-host>/playlist.m3u8`.

|  | 🐳 Docker | 🟢 Node.js |
|---|---|---|
| **Prerequisites** | Docker Engine + compose plugin | Node.js 22+ (Bun if you want to use `npm start`) |
| **Get the code** | `git clone https://github.com/Lunatic16/sportsbite-hls-proxy`<br>`cd sportsbite-hls-proxy` | ← same |
| **Configure** | `cp .env.example .env` (pick `HOST_PORT`, optionally auth) | ← same |
| **Channels** | nothing to do — first start imports the live sportsbite catalog automatically (~360 channels, `CHANNELS_IMPORT_URL`); bind your own list or turn it off — see [📥 Adding channels](#-adding-channels) | ← same (auto-import runs on `npm run dev` / `npm start` too) |
| **Run** | `docker compose -f docker-compose.yml up -d` → **http://localhost:3009** | `npm run dev` (http://localhost:3000) · or `npm run build && npm start` |
| **Verify** | `docker ps` → STATUS `healthy` · `docker compose logs -f` | open `http://localhost:3000/` |

> 💡 **Ports.** The container *always* listens on `3000` internally; the host port is `${HOST_PORT:-3009}` (compose + `.env`). This kills the old failure mode where the app and the `ports:` mapping drifted apart. On Node, `npm run dev` / `npm start` follow `PORT` (default 3000).
>
> 💡 On first start the app creates `data/`; if `data/channels.json` is missing it is seeded from `channels.example.json` and then **auto-imports the sportsbite catalog** (watch for `channel bootstrap: import complete` in the logs). If `PROXY_SECRET` is not set, one is generated and persisted to `data/secret`. The container entrypoint also fixes `./data` ownership automatically (Docker often creates the bind-mount dir as root) — **no `chown` needed on the host**; set `PUID`/`PGID` if your host user is not uid 1000.
>
> 💡 Plain `docker compose up` runs **production only** now. The old auto-merged dev override is gone; containerized development is explicit: `docker compose -f compose.dev.yml up -d`. Day-to-day, prefer `npm run dev` on the host.

<details>
<summary>🐳 <strong>Advanced Docker</strong> — hardening, persistence, LAN reachability, auto-HTTPS, multi-arch</summary>

- **Mutable state lives in `./data`** (bind-mounted to `/app/data`) — `channels.json`, share-token secrets and the proxy secret survive `docker compose down && up`.
- **Read-only rootfs** — the production service runs with `read_only: true`, `tmpfs: [/tmp]`, `no-new-privileges:true` and `cap_drop: ALL` plus exactly the four capabilities the entrypoint needs for its one-time ownership fix (`CHOWN`, `DAC_OVERRIDE`, `SETUID`, `SETGID`). Only `/app/data` and `/tmp` are writable. The container starts briefly as root, `chown`s the data dir to `PUID:PGID` (default `1000:1000`) **once**, then execs the server as that unprivileged user with all capabilities gone — `docker run --user 1000:1000` also works and skips the fix entirely.
- **Correct PID 1** — the image uses `tini` as entrypoint, so `SIGTERM` from `docker compose stop` actually reaches Node (no more 10-second kill timeouts or zombie HLS connections).
- **Healthcheck** — a Node one-liner fetches `http://127.0.0.1:3000/api/health` inside the container (explicit loopback IP, no `wget`/`curl` dependency, `PORT`-aware). A container reports `healthy` within seconds of start.
- **Bind your own channel list:** `volumes: ["./channels.json:/app/data/channels.json:ro"]` (already shown, commented, in `docker-compose.yml`).
- **Behind a reverse proxy** set `PUBLIC_BASE_URL=https://tv.example.com` and `TRUST_PROXY=true`.
- **LAN access from another device** — nothing special is needed inside Docker: the `Host` header the client sends still names your server, so generated playlist/share URLs carry the right address. If you must pin it, set `PUBLIC_BASE_URL`.
- **Automatic HTTPS** via the bundled Caddy profile:

  ```bash
  SITE_ADDRESS=tv.example.com PUBLIC_BASE_URL=https://tv.example.com TRUST_PROXY=true \
    docker compose --profile proxy up -d
  ```

  `deploy/Caddyfile` disables response buffering (`flush_interval -1`) and sets 24-hour response timeouts, which matters for streaming.
- **Multi-arch build:**

  ```bash
  docker buildx build --platform linux/amd64,linux/arm64 \
    -t <you>/iptv-stream-proxy:latest --push .
  ```

- npm helpers: `npm run docker:build` · `docker:up` · `docker:dev` · `docker:logs` · `docker:down`.
- **Image anatomy** — deps stage (`npm ci`) → build stage (`next build`, standalone output) → runtime stage on bare `node:22-alpine` + `tini` + `su-exec` + the ownership-fixing entrypoint. The runtime image ships only the standalone server, static assets, the entrypoint and `channels.example.json`; build tooling never reaches it.

</details>

## 🖥️ Web UI

Open the server root (`/`) for the viewer — sidebar + player side by side on desktop, stacked on mobile.

- **Header** — hide/show the channel list, copy the playlist URL for IPTV players, **Check status** (probes every channel with a live `n/total` progress counter), a **server status** popover (uptime, Node version, channel count, memory, cache stats — auto-refreshes every 15 s), and reload.
- **Channel sidebar** — search (`/` to focus), group filter, **Online**-only toggle, count badge, skeleton loading, per-row status dots and a per-channel re-check button.
- **Player** — hls.js with custom auto-hiding controls: play/pause, prev/next channel, volume (persisted), mute, **quality selector** (Auto + every rendition with height/bitrate), fullscreen (button, `f`, or double-click). Failures surface the server's real error text — e.g. *"matchora edge is warming up"* — instead of generic hls.js codes, with a one-click Retry. Autoplay blocked by the browser? The player falls back to muted autoplay and tells you.
- **Token dialog** — if the server runs with `AUTH_TOKEN`, the UI detects the 401/403, asks for the token once and remembers it in `localStorage`; no more "add `?token=` by hand" dead end.
- **Share & export dialog** — see [below](#-share-and-export-panel).

**Keyboard shortcuts** (ignored while typing or with a dialog open):

| Key | Action |
|---|---|
| `/` | focus channel search |
| `↑` / `↓` | previous / next channel (within the visible, filtered list) |
| `space` | play / pause |
| `f` | fullscreen |
| `m` | mute |
| `l` | hide / show the channel list |
| `esc` | leave the search field |

## 📺 Using it in IPTV players

Point any player at **`http://<server-ip>:<port>/playlist.m3u8`** — add `?token=<AUTH_TOKEN>` if you set one (players cannot send headers, so the query parameter is the portable form).

| Player | Setup |
|---|---|
| **VLC** | Media ▸ Open Network Stream — or straight from the Share panel: `vlc '<url>'`. For raw Direct URLs the panel adds `--http-user-agent=… --http-referrer=…` when the channel needs them |
| **TiviMate / OTT Navigator** | Add playlist ▸ XStream/URL — the *Dynamic M3U8 Stream URL* from the Share panel for a single channel, or the full `/playlist.m3u8`. EPG URL: `/epg.xml` |
| **IPTVnator** | Add playlist by URL — same address |
| **Kodi** | PVR IPTV Simple Client ▸ M3U Play List URL + XMLTV URL `/epg.xml` |

All generated links are signed and LAN-reachable (derived from the request `Host`); `PUBLIC_BASE_URL` overrides when needed.

## 📥 Adding channels

**Out of the box** the app imports the live sportsbite catalog at startup (`https://sportsbite.org/channels` → ~360 channels). Three env knobs control that:

```bash
CHANNELS_IMPORT_URL=https://sportsbite.org/channels   # any catalog JSON / M3U / channels-JSON source; off = disable
CHANNELS_IMPORT_MODE=once                             # once (default) | always | off
CHANNELS_IMPORT_REPLACE=auto                          # auto (default) | true | false
```

- `once` imports on the **first start** (replacing the 3 example channels) and again whenever you change the URL — tracked by `data/channels-import.json`. Your later edits to `channels.json` are never overwritten.
- `auto` replace only kicks in while `channels.json` is still the untouched example seed; a user-authored list is **merged**. Force `true`/`false` to always replace or always merge.
- A failed import (source down, no network yet) logs `channel bootstrap: import failed …` and **retries on the next start**; the previous channel list keeps serving meanwhile.

Beyond that, edit `data/channels.json` (hot-reloaded via `fs.watch`, atomic writes) or import manually:

```bash
npm run import -- https://sportsbite.org/channels      # live sportsbite catalog → custom sportsbite resolver
npm run import -- /path/to/list.m3u                    # M3U → static channels
npm run import -- /path/to/list.m3u --as-m3u-source    # M3U kept in data/source.m3u → m3u-source channels
npm run import -- channels.json --replace              # replace instead of merge

npm run check -- --id=247-beinsportsus                 # probe: playlist + first segment bytes
npm run check -- --group=Sports --limit=20             # targeted sweep (a full 1000+ sweep trips upstream rate limits)
npm run check -- --concurrency=5                       # default 5 parallel probes
```

You can also import over HTTP — handy for headless/remote servers:

```bash
curl -X POST http://localhost:3000/api/import \
  -H 'content-type: application/json' \
  -H "x-auth-token: $AUTH_TOKEN" \
  -d '{"source":"https://sportsbite.org/channels","replace":true}'
```

> ℹ️ Dead upstream families (`t247-`/`cv-` — today 404/410) are **skipped at import** unless `ALLOW_DEAD_SOURCES=true`, so a re-import cleans the list instead of cluttering the UI with dead entries.

<details>
<summary>🗂️ <strong>Channel model & resolvers</strong></summary>

```json
{
  "id": "247-beinsportsus",
  "name": "beIN SPORTS USA",
  "group": "Sports",
  "logo": "https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/united-states/bein-sports-us.png",
  "tvgId": "247-beinsportsus",
  "resolver": "custom",
  "options": { "custom": "sportsbite", "sourceId": "247-beinsportsus" }
}
```

- `resolver: "static"` — `url` (+ optional `headers`: `User-Agent`, `Referer`, `Origin`, `Cookie`, `Authorization`, arbitrary). Headers are stored server-side and referenced by short ID in proxy URLs — they never appear in links or logs.
- `resolver: "m3u-source"` — `options: { source: "./data/source.m3u" | URL, match: { tvgId } | { name } }`. The source is re-read (with a short cache) at resolve time, so regenerated upstream playlists keep working.
- `resolver: "custom"` — `options.custom` names a registered implementation. The built-in `sportsbite` resolver maps `247-`/`t247-`/`cv-` prefixes to `https://sportsbite.org/{247,t247,cv}/<slug>`. The built-in `matchora` resolver handles the `xm-<digits>` family: it fetches the matchora embed page (which requires a `https://sportsbite.org/` Referer), extracts the `var PP="…"` pass token, calls `https://matchora.to/api/play/<id>?pp=<token>` (which rejects a sportsbite Referer) and returns the edge playlist URL it hands out together with its `expires_in` TTL. Stale tokens (`reason: "pass"`) are renewed from a fresh embed page automatically; a not-yet-served channel (`warming`/`capacity`) keeps returning 502 + `Retry-After` until the edge wakes up — the same "Going live…" wait the site's own player shows. To add your own scraper/token resolver, implement the `Resolver` interface from `src/server/resolvers/types.ts` and register it in `src/server/resolvers/index.ts` via `registerResolver('name', impl)`; return `{ url, headers, expiresAt }`.

Resolutions are cached until `expiresAt` (or `RESOLVE_TTL_MS`), and invalidated automatically on upstream 403/404/410 or via `POST /api/channels/:id/invalidate`.

</details>

## ⚙️ Configuration

Everything is environment-driven (`.env`, see `.env.example`) — and every value has a default. All values are validated with zod at boot; an invalid value fails fast with a clear message.

<details>
<summary>📋 <strong>Full environment variable reference</strong></summary>

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Node listener (the container always uses `3000` internally) |
| `HOST_PORT` | `3009` | compose-only: host port mapped to the container's `3000` |
| `PUBLIC_BASE_URL` | – | Force the base URL used in generated links (reverse proxy) |
| `TRUST_PROXY` | `false` | Honor `X-Forwarded-Proto`/`-Host` |
| `PROXY_SECRET` | auto-generated | HMAC secret for signed proxy URLs (persisted to `data/secret`); `*_FILE` variants supported |
| `AUTH_TOKEN` | – (open LAN mode) | Global token for UI/API/playlist; `Authorization: Bearer`, `x-auth-token`, or `?token=` |
| `SHARE_TOKEN_TTL` | `0` (never) | Per-channel share token lifetime in seconds |
| `SHARE_TOKEN_REQUIRED` | `false` | Require a share token on `/live` and `/stream` |
| `CACHE_TTL_PLAYLIST_MS` / `CACHE_TTL_VOD_MS` | `1000` / `60000` | Upstream playlist micro-cache (live playlists must stay fresh — tokens rotate) |
| `PLAYLIST_CACHE_MAX` | `256` | Max cached playlists |
| `SEG_CACHE_TTL_MS` / `SEG_CACHE_MAX_MB` | `0` / `256` | Optional decoded-segment micro-cache so player retries don't re-hit a dead URL |
| `REQUEST_TIMEOUT_MS` / `CONNECT_TIMEOUT_MS` | `15000` / `5000` | Upstream timeouts |
| `MAX_RETRIES` / `MAX_REDIRECTS` | `2` / `8` | Retry 5xx/network resets with backoff; redirect cap (each hop SSRF-checked) |
| `RESOLVE_TTL_MS` / `RESOLVE_TIMEOUT_MS` | `300000` / `10000` | Resolver cache + timeout |
| `ALLOW_PRIVATE_UPSTREAMS` | `false` | Set `true` only if an upstream really lives on your LAN or another container |
| `ALLOW_DEAD_SOURCES` | `false` | Re-enable importing the dead `t247-`/`cv-` families (404/410 today) |
| `CHANNELS_IMPORT_URL` | `https://sportsbite.org/channels` | Startup auto-import source (catalog JSON / M3U URL / channels JSON); `off` disables |
| `CHANNELS_IMPORT_MODE` | `once` | `once` = first start + URL changes · `always` = every start · `off` |
| `CHANNELS_IMPORT_REPLACE` | `auto` | `auto` = replace only the untouched example seed · `true` = replace · `false` = merge |
| `STRIP_REFERER_HOSTS` | `tiktokcdn` | Host substrings that must never receive Referer/Origin |
| `USER_AGENT` | Firefox UA | Default upstream UA |
| `UPSTREAM_MAX_BODY_MB` / `UNWRAP_MAX_BUFFER_MB` | `8` / `64` | Playlist read cap / wrapped-segment decode cap |
| `CHECK_CONCURRENCY` / `CHECK_TIMEOUT_MS` | `4` / `8000` | Status-probe parallelism + per-channel timeout |
| `DATA_DIR` / `CHANNELS_FILE` | `./data` / `$DATA_DIR/channels.json` | Storage |
| `LOG_LEVEL` / `TZ` | `info` / `UTC` | pino level / container timezone |

</details>

## 🔗 Share and export panel

Every channel gets a **Share & export** dialog in the web UI with five copyable options.

<details>
<summary>🔗 <strong>What's in the dialog</strong></summary>

1. **Our Live URL** (`{base}/live/<id>?token=<shareToken>`) — recommended; re-resolves expired upstream URLs on every request, so the link never goes stale. Shown with a QR code.
2. **Dynamic M3U8 Stream URL** (`{base}/stream/<id>.m3u8?token=...`) — the URL the generated playlist uses.
3. **Direct URL** — the raw upstream URL with an expiry countdown (from the resolver's `expiresAt`; "Expiry unknown" if absent) and a Refresh button. Returned only to authenticated callers and never logged; `Cookie`/`Authorization` are redacted from the response.
4. **VLC** command with POSIX / PowerShell / cmd.exe variants and a Live/Direct toggle.
5. **MPV** command with `--user-agent`, `--referrer`, `--http-header-fields='Origin: ...'` as needed.

**Regenerate token** rotates that channel's secret (`data/tokens.json`) and kills its old links — guarded by a confirmation dialog, since the old links die immediately. Share tokens are bound to a single channel: a token for A gets **403** on B and **401** on `/api/*`.

</details>

## 🔌 API

<details>
<summary>🗂️ <strong>Route reference</strong> (all handlers under <code>src/app</code>, Node.js runtime)</summary>

| Route | Purpose |
|---|---|
| `GET /api/health` | Status JSON (always open; Docker healthcheck target) |
| `GET /api/status` | Uptime, memory, cache stats, effective config snapshot |
| `GET /api/channels[?group=&search=]` | Channel list (sanitized — no headers) |
| `GET /api/channels/:id` | Single channel + its stream/live URLs |
| `GET /api/channels/:id/share` | live/m3u8/direct/vlc/mpv payload |
| `POST /api/channels/:id/refresh` | Force re-resolve (Direct URL refresh) |
| `POST /api/channels/:id/rotate-token` | Rotate the channel's share secret |
| `POST /api/channels/:id/invalidate` | Drop the cached resolved URL for one channel |
| `POST /api/channels/:id/check` | Probe one channel (playlist + first segment) |
| `POST /api/check` | Probe a batch — body `{ ids?, group?, search?, concurrency? }` |
| `POST /api/import` | Import channels — body `{ source, replace?, asM3uSource? }` |
| `POST /api/reload` | Re-read channels.json + clear caches |
| `GET /playlist.m3u8` (`.m3u`, `/playlist`, `/api/playlist`) | Generated IPTV playlist (`?group=&search=&format=&download=1`) |
| `GET /epg.xml` (`/api/epg`) | XMLTV channel stub |
| `GET /stream/:id.m3u8` (`/api/stream/:id`) | Channel entry point (re-resolve + retry built in) |
| `GET /live/:id` | Alias without extension (share links) |
| `GET /proxy/playlist?url=&h=&s=` | Signed playlist proxy |
| `GET /proxy/segment?url=&h=&s=` | Signed segment proxy (Range passthrough, per-response unwrap) |
| `GET /proxy/key?url=&h=&s=` | Signed key proxy |

Every endpoint answers JSON errors with a readable `error` message (that's what the UI's error overlay displays), and aborted client requests return 499 instead of a fake 502.

</details>

## 🔒 Security notes

<details>
<summary>🛡️ <strong>SSRF, URL signing, header hygiene & auth</strong></summary>

- **SSRF** — only `http`/`https` upstreams; loopback, private, link-local, CGNAT, benchmark, multicast and cloud-metadata ranges are rejected (URL literals *and* every resolved IP at connect time via a custom undici DNS resolver, closing DNS rebinding). Docker host gateway (`172.17.0.1`) and `169.254.169.254` are covered by the private/link-local rules. `ALLOW_PRIVATE_UPSTREAMS=true` is the documented escape hatch for LAN/container upstreams.
- **Signed proxy URLs** — `url` is base64url, `s` is an HMAC-SHA256 over `kind|url|headersId`. Tampering with any part, or replaying a playlist URL as a segment/key, fails verification — and the SSRF guard re-validates every URL *even when the signature is valid*.
- **Header hygiene** — channel headers live in a server-side registry keyed by short ID. `Cookie`/`Authorization` are stripped on cross-origin redirects and never returned to the UI (`publicHeaders()` exposes only UA/Referer/Origin); Referer/Origin are stripped for `STRIP_REFERER_HOSTS` (TikTok CDN 403s on Referer). Logs carry redacted URLs (no `url`/`s`/`token` values) and never header values.
- **Auth** — `AUTH_TOKEN` guards UI/API/playlist and channel entry points; accepted via `Authorization: Bearer`, `x-auth-token` or `?token=`. Share tokens are per-channel HMACs; when `SHARE_TOKEN_REQUIRED=true`, `/live` and `/stream` demand a valid per-channel token, and an invalid supplied token is always a 403. Proxy routes are protected by signature, not token. In open LAN mode (no tokens) the server is meant for a trusted network — scope it accordingly or put auth in front.

</details>

## 🩺 Troubleshooting

<details>
<summary>🩹 <strong>Common issues & fixes</strong></summary>

- **CORS errors in the browser** — the proxy adds `Access-Control-Allow-Origin: *` and answers preflight on `/proxy/*` and stream routes. If you see CORS errors, you are probably pointing hls.js at an **upstream URL directly** instead of the proxy/stream URL. Always use `/stream/<id>.m3u8` or the share links.
- **"Nothing plays / every channel fails"** — the upstream restructured its catalog: the `t247-` (timst) family now answers 404 `not found`, `cv-` (cinevid) answers 410 `source removed`, and the `xm-` family (majority of the catalog) needs the matchora chain. **Re-import the catalog** (`npm run import -- https://sportsbite.org/channels --replace`) so dead channels are dropped and `xm-` channels get the right resolver.
- **403 from upstream on one channel** — usually an expired/absent header (check the channel's `headers`) or origin fingerprinting. A stale-token 403/404 on segments is *expected* upstream behavior: players re-poll the playlist and the proxy re-issues fresh segment URLs on every refresh; the share/stream entry points re-resolve and retry once automatically.
- **"Channel only works after opening it in the webapp once"** — one-shot players fail on a single upstream hiccup. The retry ladder lives in `/live` and `/stream`; make sure the player points at those, not a raw URL.
- **`xm-` channel stuck on "warming"** — the matchora edge serves channels on demand: with no active viewers it answers 404 `warming` until it spins up (the site's player shows the same "Going live…" wait). The proxy keeps re-resolving per request; keep the player open and it usually starts within a few refresh cycles. Some 24/7 channels stay cold for hours when nobody watches.
- **Expired tokens / stale links** — Live and M3U8 links keep working by design. Direct URLs expire with the upstream (watch the countdown, hit Refresh). Regenerating a token deliberately kills old links.
- **Docker unhealthy** — the healthcheck fetches `http://127.0.0.1:3000/api/health` inside the container; check `docker compose logs`. The container port is always 3000 — if you reached the UI on the host at all, health should pass; a `restart loop` instead of `unhealthy` usually means the `./data` mount is not writable (see next item).
- **"Could not load channels (HTTP 500)"** — the UI now shows the real reason instead of a bare 500. Usual causes, in order of likelihood:
  1. **`./data` not writable by uid 1000** (Docker created the bind-mount dir as root, or an old root-run container owns the files). **The entrypoint fixes this automatically on start** — you only need `sudo chown -R 1000:1000 ./data` if the container cannot (e.g. the fix is skipped when running `--user`, or the capabilities were removed). Check the logs for `[entrypoint]` lines: a `WARNING: could not chown …` means the host-side chown is required. Until fixed, signing falls back to an **ephemeral in-memory secret** (proxy URLs reset on restart) and the channel list reports the permission error verbatim.
  2. **`data/channels.json` is not valid JSON** — the error names the file and the exact parse position; fix or delete the file (it re-seeds from `channels.example.json`).
  3. **Invalid env var** (e.g. a bad `LOG_LEVEL` or a `PROXY_SECRET` shorter than 16 chars) — the error is returned as-is.
  Diagnosis: `curl http://localhost:3009/api/health` — it stays `ok:true` (so the container looks healthy) but includes a `channelsError` field with the reason; the same reason is printed by `docker compose logs iptv-proxy`.
- **Crash loop: `[FATAL tini] exec /app/docker-entrypoint.sh failed: Permission denied`** — the entrypoint script lost its exec bit (some builders/zip tools drop it). Fixed in the image itself: the script is `chmod`-ed in a `RUN` step **and** tini launches it via `sh`, which does not need the exec bit. Make sure you rebuilt (`docker compose up -d --build`; if in doubt `docker compose build --no-cache`).
- **`EACCES` writing `data/`** — normally impossible: the entrypoint starts as root, fixes the data dir ownership, then drops to `PUID:PGID` (default uid 1000). If you see this anyway, check `docker compose logs iptv-proxy` for `[entrypoint] WARNING: could not chown` — it means the chown failed (caps stripped or a read-only mount); run `sudo chown -R ${PUID:-1000}:${PGID:-1000} ./data` on the host.
- **"Nothing on :3000" under Docker** — the host port is `${HOST_PORT:-3009}`; open **:3009** or set `HOST_PORT` in `.env`. Inside the compose network (e.g. Caddy) the app is `iptv-proxy:3000`.
- **401 in the web UI** — the server runs with `AUTH_TOKEN`; paste it into the token dialog once (it is remembered), or append `?token=…` to the URL. IPTV players need `?token=`.
- **"Autoplay was blocked"** — browsers refuse autoplay with sound; tap the video or press `space` (the player already tried muted playback).
- **No LAN reachability** — set `PUBLIC_BASE_URL=http://<lan-ip>:<port>`, or check firewall rules; the app binds `0.0.0.0`.
- **Imported dead channels** — imports skip `t247-`/`cv-` by default now; use `ALLOW_DEAD_SOURCES=true` to keep them anyway.
- **"Channel list is empty / only 3 example channels"** — the startup auto-import did not run or failed. Check `docker compose logs iptv-proxy` for `channel bootstrap` lines:
  - `import failed — … will retry on next start` — the source was unreachable at boot (no network yet, DNS, firewall). It retries automatically on the next restart, or import right now: `curl -X POST http://localhost:3009/api/import -H 'content-type: application/json' -d '{"source":"https://sportsbite.org/channels","replace":true}'`.
  - `disabled by config` — `CHANNELS_IMPORT_URL=off` or `CHANNELS_IMPORT_MODE=off` is set; unset it if you want the catalog.
  - `already imported (once mode) — skipping` — the marker `data/channels-import.json` records a successful import of this URL; delete that file (or set `CHANNELS_IMPORT_MODE=always`) to force a re-import. If you had previously imported the catalog and then emptied the list, this skip is why.

</details>

## 🛠️ Development

```bash
npm run dev          # next dev on :3000 (React UI + API routes, fast refresh)
npm run build        # next build → standalone server (.next/standalone)
npm start            # bun .next/standalone/server.js  (or: node .next/standalone/server.js)
npm run test         # vitest (rewriter, SSRF, signing, share tokens, playlist gen, shell escaping, unwrap, import, matchora, channel bootstrap)
npm run typecheck    # tsc --noEmit (strict)
npm run lint         # eslint
```

<details>
<summary>🏗️ <strong>Project layout & design decisions</strong></summary>

Layout:

- `src/app` — Next.js App Router: `page.tsx` (viewer) + route handlers — `stream/[channelId]`, `live/[channelId]`, `proxy/[kind]`, `playlist.m3u8`, `epg.xml`, and the whole `api/*` surface
- `src/components/viewer` — the React UI: `viewer` (shell), `channel-list`, `player`, `share-dialog`, `token-dialog`, `server-status`, `checks`
- `src/components/ui` — shadcn/ui primitives (Radix + Tailwind)
- `src/lib` — client side: typed API client (`api.ts`), zustand store + localStorage prefs (`store.ts`), shared types
- `src/server` — the proxy core: `config` (zod env), `auth`, `sign`, `proxyVerify`, `ssrf`, `fetchUpstream`, `parser` + `playlistService`, `segmentService`, `streamService`, `unwrap`, `resolvers/`, `channels/` (store + import + startup bootstrap), `headerRegistry`, `shareStore`, `probe`, `m3u`, `mime`, `cache`, `http`, `logger`, `shellEscape`, `resolveUri`
- `scripts/import.ts` · `scripts/check.ts` — CLI wrappers around the same core
- `tests/` — vitest suites (node environment, `@` aliased to `src`)
- `docker-compose.yml` (production) · `compose.dev.yml` (explicit containerized dev) · `Dockerfile` · `Caddyfile` / `deploy/Caddyfile`

Design decisions worth knowing:

- **One instance per process** — config, channel store, resolver registry, caches and the header registry live on `globalThis`, because Next.js route bundles would otherwise each build their own copy (duplicated caches, multiple `fs.watch`ers, one `DATA_DIR` setup per route).
- **Live playlists are micro-cached for 1 s** so a sliding window never serves stale tokens; VOD gets 60 s.
- **Decoded segments are the only fully-buffered bodies** (bounded by `UNWRAP_MAX_BUFFER_MB`); everything else streams.
- **Retry contract** — upstream 403/404/410 → invalidate the cached resolution → re-resolve → retry once. Segment/key proxy URLs are re-issued on every playlist refresh rather than carrying an expiry of their own — their effective lifetime equals the upstream token lifetime embedded in each URL.
- **`channels.json` is hot-reloaded** (`fs.watch`, debounced) and saved atomically (tmp + rename); a restart re-registers headers on the next resolve since the header registry is in-memory.
- **The healthcheck is a Node one-liner** on `/api/health` — no `curl`/`wget` in the image, IPv4-safe, `PORT`-aware.
- `hls.js` and `qrcode-generator` are runtime dependencies, imported lazily by the player / share dialog so the initial page load stays small.

</details>

## 📄 License

Released under the [MIT License](LICENSE).

## 🙏 Credits

Stream derivation, token behavior, TikTok wrapper formats and header rules come from the project's upstream research notes (re-verified 2026-11-18 against sportsbite.org, incl. the `xm-`/matchora source and its `payload-iTXt` segment disguise). This project is a self-hosted viewer for personal use — respect the upstream providers and your local laws.
