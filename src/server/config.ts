/**
 * Configuration: environment parsing + validation (zod).
 * All knobs live in .env (see .env.example). Secret `*_FILE` variants are
 * supported for Docker secrets (PROXY_SECRET_FILE, AUTH_TOKEN_FILE).
 *
 * The parsed config is memoized on globalThis so every Next.js route handler
 * shares exactly one instance (route bundles would otherwise duplicate the
 * module state and create one DATA_DIR setup per route).
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { describeFsError } from './fsErrors';

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function envInt(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: "${v}" is not a number`);
  return n;
}

function readSecret(name: string): string | undefined {
  const direct = process.env[name];
  const fileVar = process.env[`${name}_FILE`];
  if (direct) return direct.trim();
  if (fileVar) {
    try {
      const val = fs.readFileSync(fileVar, 'utf8').trim();
      if (val) return val;
    } catch (err) {
      throw new Error(`${name}_FILE points at an unreadable file: ${fileVar} (${(err as Error).message})`);
    }
  }
  return undefined;
}

const schema = z.object({
  port: z.number().int().min(1).max(65535),
  host: z.string().min(1),
  publicBaseUrl: z.string().optional(),
  proxySecret: z.string().min(16),
  authToken: z.string().optional(),
  shareTokenTtl: z.number().int().min(0),
  shareTokenRequired: z.boolean(),
  cacheTtlPlaylistMs: z.number().int().min(0),
  cacheTtlVodMs: z.number().int().min(0),
  playlistCacheMax: z.number().int().min(8),
  segCacheTtlMs: z.number().int().min(0),
  segCacheMaxMb: z.number().int().min(0),
  requestTimeoutMs: z.number().int().min(1000),
  connectTimeoutMs: z.number().int().min(500),
  maxRetries: z.number().int().min(0).max(10),
  maxRedirects: z.number().int().min(0).max(20),
  allowPrivateUpstreams: z.boolean(),
  trustProxy: z.boolean(),
  allowDeadSources: z.boolean(),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  dataDir: z.string().min(1),
  channelsFile: z.string().min(1),
  userAgent: z.string().min(4),
  stripRefererHosts: z.array(z.string().min(2)),
  unwrapMaxBufferMb: z.number().int().min(1).max(512),
  upstreamMaxBodyMb: z.number().int().min(1).max(64),
  resolveTtlMs: z.number().int().min(1000),
  resolveTimeoutMs: z.number().int().min(1000),
  checkConcurrency: z.number().int().min(1).max(16),
  checkTimeoutMs: z.number().int().min(1000),
  /** Startup auto-import source ('' = disabled). See channels/bootstrap.ts. */
  channelsImportUrl: z.string(),
  channelsImportMode: z.enum(['once', 'always', 'off']),
  channelsImportReplace: z.enum(['auto', 'true', 'false']),
});

export type Config = z.infer<typeof schema>;

/**
 * Generates a PROXY_SECRET if missing and persists it under DATA_DIR/secret,
 * so signed proxy URLs survive restarts instead of failing hard.
 *
 * Best-effort by design: if the data directory is not writable (the classic
 * case being a Docker bind mount that Docker created as root on the host,
 * while the container runs as uid 1000), fall back to an ephemeral in-memory
 * secret and warn loudly. Throwing here would 500 EVERY route that touches
 * loadConfig(), while /api/health swallows store errors — the container would
 * look "healthy" while the app is completely broken ("Could not load
 * channels / HTTP 500").
 *
 * NOTE: no pino logger here — logger.ts imports loadConfig(), so calling
 * getLogger() from inside buildConfig() would recurse infinitely.
 */
function ensureProxySecret(dataDir: string): string {
  const fromEnv = readSecret('PROXY_SECRET');
  if (fromEnv) return fromEnv;
  const secretFile = path.join(dataDir, 'secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* missing or unreadable — try to (re)create below */
  }
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretFile, generated + '\n', { mode: 0o600 });
  } catch (err) {
    console.warn(
      `[iptv-proxy] cannot persist PROXY_SECRET: ${describeFsError(err, secretFile)}\n` +
        '[iptv-proxy] using an EPHEMERAL in-memory secret: signed proxy URLs will invalidate on restart.\n' +
        '[iptv-proxy] fix on the host: sudo chown -R 1000:1000 ./data   (or set PROXY_SECRET explicitly)',
    );
  }
  return generated;
}

interface GlobalState {
  __iptvConfig?: Config;
}

const g = globalThis as unknown as GlobalState;

function buildConfig(): Config {
  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Channel bootstrap: the app imports its channel list from this source at
  // every start (sportsbite catalog JSON, M3U/M3U8 URL, or channel JSON — the
  // same inputs as POST /api/import). "off"/empty disables the auto-import.
  const rawImportUrl = (
    process.env.CHANNELS_IMPORT_URL ?? 'https://sportsbite.org/channels'
  ).trim();
  const channelsImportUrl = ['off', 'none', 'disabled', 'false', '0'].includes(
    rawImportUrl.toLowerCase(),
  )
    ? ''
    : rawImportUrl;

  const parsed = schema.parse({
    port: envInt('PORT', 3000),
    host: process.env.HOST ?? '0.0.0.0',
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, '') || undefined,
    proxySecret: ensureProxySecret(dataDir),
    authToken: readSecret('AUTH_TOKEN'),
    shareTokenTtl: envInt('SHARE_TOKEN_TTL', 0),
    shareTokenRequired: envBool('SHARE_TOKEN_REQUIRED', false),
    cacheTtlPlaylistMs: envInt('CACHE_TTL_PLAYLIST_MS', 1000),
    cacheTtlVodMs: envInt('CACHE_TTL_VOD_MS', 60_000),
    playlistCacheMax: envInt('PLAYLIST_CACHE_MAX', 256),
    segCacheTtlMs: envInt('SEG_CACHE_TTL_MS', 0),
    segCacheMaxMb: envInt('SEG_CACHE_MAX_MB', 256),
    requestTimeoutMs: envInt('REQUEST_TIMEOUT_MS', 15_000),
    connectTimeoutMs: envInt('CONNECT_TIMEOUT_MS', 5_000),
    maxRetries: envInt('MAX_RETRIES', 2),
    maxRedirects: envInt('MAX_REDIRECTS', 8),
    allowPrivateUpstreams: envBool('ALLOW_PRIVATE_UPSTREAMS', false),
    trustProxy: envBool('TRUST_PROXY', false),
    // t247-/cv- upstream families are dead (404/410). Skip them at import
    // unless explicitly re-enabled.
    allowDeadSources: envBool('ALLOW_DEAD_SOURCES', false),
    logLevel: (process.env.LOG_LEVEL ?? 'info') as Config['logLevel'],
    dataDir,
    channelsFile: path.resolve(process.env.CHANNELS_FILE ?? path.join(dataDir, 'channels.json')),
    userAgent:
      process.env.USER_AGENT ??
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    stripRefererHosts: (process.env.STRIP_REFERER_HOSTS ?? 'tiktokcdn')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length >= 2),
    unwrapMaxBufferMb: envInt('UNWRAP_MAX_BUFFER_MB', 64),
    upstreamMaxBodyMb: envInt('UPSTREAM_MAX_BODY_MB', 8),
    resolveTtlMs: envInt('RESOLVE_TTL_MS', 300_000),
    resolveTimeoutMs: envInt('RESOLVE_TIMEOUT_MS', 10_000),
    checkConcurrency: envInt('CHECK_CONCURRENCY', 4),
    checkTimeoutMs: envInt('CHECK_TIMEOUT_MS', 8_000),
    channelsImportUrl,
    channelsImportMode: (process.env.CHANNELS_IMPORT_MODE ?? 'once') as Config['channelsImportMode'],
    channelsImportReplace: (process.env.CHANNELS_IMPORT_REPLACE ?? 'auto') as Config['channelsImportReplace'],
  });

  if (parsed.publicBaseUrl && !/^https?:\/\//.test(parsed.publicBaseUrl)) {
    throw new Error('PUBLIC_BASE_URL must start with http:// or https://');
  }
  return parsed;
}

/** Load (and memoize) the app configuration. Throws on invalid env values. */
export function loadConfig(): Config {
  if (!g.__iptvConfig) g.__iptvConfig = buildConfig();
  return g.__iptvConfig;
}

/** Test helper: reset the memoized config. */
export function resetConfigForTests(): void {
  g.__iptvConfig = undefined;
}
