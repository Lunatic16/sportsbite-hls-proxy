/**
 * HMAC signing for proxy URLs and per-channel share tokens.
 *
 * Proxy URLs encode the upstream URL as base64url + a header-set ID and carry
 * an HMAC-SHA256 signature over kind|url|headers, so they cannot be tampered
 * with or replayed against a different route kind.
 *
 * Share tokens are scoped to a single channel: `<channelId>.<exp?>.<sig>`
 * signed with a per-channel secret (rotatable), so a token for channel A can
 * never open channel B or any admin/API route.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '../config.js';

export type ProxyKind = 'playlist' | 'segment' | 'key';

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function encodeUrlForProxy(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

export function decodeUrlForProxy(encoded: string): string {
  const decoded = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!decoded) throw new Error('empty url parameter');
  return decoded;
}

export function signProxyUrl(kind: ProxyKind, encodedUrl: string, headersId: string): string {
  const { proxySecret } = loadConfig();
  return hmac(proxySecret, `${kind}|${encodedUrl}|${headersId}`);
}

/** Build a signed proxy URL: /proxy/<kind>?url=<b64url>&h=<headersId>&s=<sig>. */
export function buildProxyUrl(
  kind: ProxyKind,
  origin: string,
  url: string,
  headersId: string,
): string {
  const encoded = encodeUrlForProxy(url);
  const sig = signProxyUrl(kind, encoded, headersId);
  return `${origin}/proxy/${kind}?url=${encoded}&h=${headersId}&s=${sig}`;
}

export function verifyProxyUrl(
  kind: ProxyKind,
  encodedUrl: string,
  headersId: string,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  return safeEqual(signProxyUrl(kind, encodedUrl, headersId), signature);
}

/** Short, non-secret ID of a header set (server-side registry key). */
export function headersIdFor(headers: Record<string, string | undefined> | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return 'none';
  const canonical = Object.keys(headers)
    .sort()
    .map((k) => `${k.toLowerCase()}:${headers[k]}`)
    .join('\n');
  return createHmac('sha256', loadConfig().proxySecret).update(canonical).digest('hex').slice(0, 12);
}

// ── Share tokens ────────────────────────────────────────────────────────────

export interface ShareTokenClaims {
  channelId: string;
  /** Unix ms expiry; undefined = non-expiring. */
  exp?: number;
}

export interface ShareTokenVerifier {
  issue(channelId: string, secret: string): string;
  verify(channelId: string, token: string | undefined, secret: string): boolean;
}

/**
 * Token shape: `<channelId>[.<exp>].<sig>` where
 * sig = HMAC-SHA256(channelSecret, `share|<channelId>|<exp>`)[:32].
 */
export const shareTokens: ShareTokenVerifier = {
  issue(channelId: string, secret: string): string {
    const cfg = loadConfig();
    const exp = cfg.shareTokenTtl > 0 ? Date.now() + cfg.shareTokenTtl * 1000 : 0;
    const sig = hmac(secret, `share|${channelId}|${exp}`);
    const head = exp > 0 ? `${encodeURIComponent(channelId)}.${exp}` : encodeURIComponent(channelId);
    return `${head}.${sig}`;
  },

  verify(channelId: string, token: string | undefined, secret: string): boolean {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 2 && parts.length !== 3) return false;
    const tokenChannel = decodeURIComponent(parts[0]);
    if (tokenChannel !== channelId) return false;
    let exp = 0;
    let sig: string;
    if (parts.length === 3) {
      exp = Number(parts[1]);
      if (!Number.isFinite(exp) || exp < 0) return false;
      sig = parts[2];
    } else {
      sig = parts[1];
    }
    if (exp > 0 && Date.now() > exp) return false;
    return safeEqual(hmac(secret, `share|${channelId}|${exp}`), sig);
  },
};

export function randomSecret(): string {
  return randomBytes(24).toString('base64url');
}
