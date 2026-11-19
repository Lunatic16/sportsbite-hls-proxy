/**
 * Request helpers for Next.js route handlers: public base URL derivation.
 */
import type { NextRequest } from 'next/server';
import { loadConfig } from './config';

/**
 * Base URL used in generated playlists / share links:
 * PUBLIC_BASE_URL > X-Forwarded-Proto/Host (when TRUST_PROXY) > Host header.
 * Never hardcodes localhost, so LAN clients get reachable addresses.
 */
export function publicBase(req: NextRequest): string {
  const cfg = loadConfig();
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl;

  let proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim() ?? '';
  let host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() ?? '';
  if (!cfg.trustProxy) {
    // Ignore spoofable forwarded headers unless TRUST_PROXY is enabled.
    proto = '';
    host = '';
  }
  if (!proto) proto = new URL(req.url).protocol.replace(':', '');
  if (!host) host = req.headers.get('host') ?? '';
  if (!host) {
    host = `${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  }
  return `${proto}://${host}`;
}
