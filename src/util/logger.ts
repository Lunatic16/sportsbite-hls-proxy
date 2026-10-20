/**
 * Logging: pino instance + helpers that keep sensitive material out of logs.
 * Never log full signed proxy URLs or header values at info level.
 */
import pino from 'pino';
import { loadConfig } from '../config.js';

let instance: pino.Logger | undefined;

/** Params that carry signed material; their values are redacted in log URLs. */
const SENSITIVE_QUERY_PARAMS = new Set(['url', 'h', 's', 'token']);

/**
 * Replaces sensitive query values with `<redacted>` and truncates very long
 * paths (base64 segment URLs would otherwise flood logs).
 */
export function redactUrl(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl, 'http://placeholder.local');
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_PARAMS.has(key)) u.searchParams.set(key, '<redacted>');
    }
    const qs = u.searchParams.toString();
    let out = u.pathname + (qs ? `?${qs}` : '');
    if (out.length > 160) out = out.slice(0, 157) + '...';
    return out;
  } catch {
    return '<unparseable-url>';
  }
}

/** Origin + first path segment only, for upstream references in logs. */
export function shortUpstream(rawUrl: string | undefined): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    const seg = u.pathname.split('/').filter(Boolean)[0] ?? '';
    return `${u.host}/${seg}`;
  } catch {
    return '<unparseable-upstream>';
  }
}

export function getLogger(): pino.Logger {
  if (instance) return instance;
  const cfg = loadConfig();
  instance = pino({
    level: cfg.logLevel,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-auth-token"]'],
      censor: '[REDACTED]',
    },
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  return instance;
}

/** Fastify request serializer that never emits raw signed URLs. */
export function fastifyReqSerializer(req: { method?: string; url?: string }): object {
  return { method: req.method, url: redactUrl(req.url) };
}
