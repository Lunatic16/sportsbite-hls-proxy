/**
 * Access control.
 *
 * - AUTH_TOKEN (optional global): guards the web UI, /api/*, /playlist* and
 *   channel stream entry points. Accepted via `Authorization: Bearer`,
 *   `x-auth-token` header, or `?token=` (needed by IPTV players).
 * - Share tokens (per-channel HMAC): grant access ONLY to that channel's
 *   /live/:id and /stream/:id.m3u8 endpoints — never the admin API or other
 *   channels. Required when SHARE_TOKEN_REQUIRED=true; validated whenever
 *   present (an invalid supplied token is always rejected).
 * - Proxy routes (/proxy/*) are protected by their HMAC signature instead.
 */
import type { FastifyRequest } from 'fastify';
import { loadConfig } from './config.js';
import { shareTokens } from './net/sign.js';
import { getChannelSecret } from './net/shareStore.js';

export type AuthResult = { ok: true } | { ok: false; status: 401 | 403; reason: string };

function extractBearer(req: FastifyRequest): string | undefined {
  const auth = req.headers.authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  const header = req.headers['x-auth-token'];
  if (typeof header === 'string' && header) return header;
  const q = (req.query as Record<string, string> | undefined)?.['token'];
  return q || undefined;
}

/** Global authentication (AUTH_TOKEN). No-op when not configured. */
export function checkGlobalAuth(req: FastifyRequest): AuthResult {
  const cfg = loadConfig();
  if (!cfg.authToken) return { ok: true };
  const provided = extractBearer(req);
  if (provided && provided === cfg.authToken) return { ok: true };
  return { ok: false, status: 401, reason: 'authentication required (AUTH_TOKEN)' };
}

/**
 * Channel-scoped access for /live/:id and /stream/:id.m3u8:
 * global token OR this channel's share token (mandatory when
 * SHARE_TOKEN_REQUIRED=true; an invalid token is always a 403).
 */
export function checkChannelAccess(req: FastifyRequest, channelId: string): AuthResult {
  const cfg = loadConfig();
  const provided = extractBearer(req);

  if (cfg.authToken && provided === cfg.authToken) return { ok: true };

  if (provided) {
    // A token was supplied: it must be this channel's valid share token.
    if (shareTokens.verify(channelId, provided, getChannelSecret(channelId))) return { ok: true };
    return { ok: false, status: 403, reason: 'invalid or expired share token' };
  }

  if (cfg.shareTokenRequired) {
    return { ok: false, status: 401, reason: 'share token required (?token=)' };
  }
  return { ok: true };
}

/**
 * Who is "authenticated" for the Share & export endpoint: global token, or a
 * valid per-channel share token (the direct upstream URL is only ever
 * returned to authenticated callers).
 */
export function checkShareAuth(req: FastifyRequest, channelId: string): AuthResult {
  const cfg = loadConfig();
  const provided = extractBearer(req);
  if (cfg.authToken && provided === cfg.authToken) return { ok: true };
  if (provided && shareTokens.verify(channelId, provided, getChannelSecret(channelId))) return { ok: true };
  if (!cfg.authToken && !cfg.shareTokenRequired) return { ok: true }; // open LAN mode
  return { ok: false, status: 401, reason: 'authentication required for share details' };
}
