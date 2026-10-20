/**
 * Configuration: environment parsing + validation (zod).
 * All knobs live in .env (see .env.example). Secret `*_FILE` variants are
 * supported for Docker secrets (PROXY_SECRET_FILE, AUTH_TOKEN_FILE).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

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
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']),
  dataDir: z.string().min(1),
  channelsFile: z.string().min(1),
  userAgent: z.string().min(4),
  stripRefererHosts: z.array(z.string().min(2)),
  unwrapMaxBufferMb: z.number().int().min(1).max(512),
  upstreamMaxBodyMb: z.number().int().min(1).max(64),
  resolveTtlMs: z.number().int().min(1000),
  resolveTimeoutMs: z.number().int().min(1000),
});

export interface Config extends z.infer<typeof schema> {
  readonly port: number;
  readonly host: string;
}

/**
 * Generates a PROXY_SECRET if missing and persists it under DATA_DIR/secret,
 * so signed proxy URLs survive restarts instead of failing hard.
 */
function ensureProxySecret(dataDir: string): string {
  const fromEnv = readSecret('PROXY_SECRET');
  if (fromEnv) return fromEnv;
  const secretFile = path.join(dataDir, 'secret');
  try {
    const existing = fs.readFileSync(secretFile, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    /* not there yet */
  }
  const generated = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(secretFile, generated + '\n', { mode: 0o600 });
  return generated;
}

let cached: Config | undefined;

export function loadConfig(): Config {
  if (cached) return cached;

  const dataDir = path.resolve(process.env.DATA_DIR ?? './data');
  fs.mkdirSync(dataDir, { recursive: true });

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
  });

  if (parsed.publicBaseUrl && !/^https?:\/\//.test(parsed.publicBaseUrl)) {
    throw new Error('PUBLIC_BASE_URL must start with http:// or https://');
  }

  cached = parsed;
  return parsed;
}

/** Test helper: reset the memoized config. */
export function resetConfigForTests(): void {
  cached = undefined;
}
