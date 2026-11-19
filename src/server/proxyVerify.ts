/**
 * Shared helpers for Next.js route handlers: signed proxy request
 * verification and consistent error/JSON responses.
 */
import type { NextRequest } from 'next/server';
import { decodeUrlForProxy, verifyProxyUrl, type ProxyKind } from './sign';
import { lookupHeaders } from './headerRegistry';
import { assertUpstreamAllowed } from './ssrf';
import { loadConfig } from './config';
import type { UpstreamHeaders } from './fetchUpstream';

export class ProxyAuthError extends Error {}

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  };
}

export function jsonError(status: number, message: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...extraHeaders,
    },
  });
}

/**
 * Verify a signed /proxy/* request: HMAC signature over kind|url|headers,
 * then a defense-in-depth SSRF re-check even when the signature is valid.
 */
export function verifyProxyRequest(
  req: NextRequest,
  kind: ProxyKind,
): { url: string; headers: UpstreamHeaders | undefined } {
  const q = req.nextUrl.searchParams;
  const urlParam = q.get('url');
  const sig = q.get('s');
  const h = q.get('h') ?? 'none';
  if (!urlParam || !sig) throw new ProxyAuthError('missing url or signature');
  if (!verifyProxyUrl(kind, urlParam, h, sig)) {
    throw new ProxyAuthError('invalid signature');
  }
  const url = decodeUrlForProxy(urlParam);
  // Defense in depth: even with a valid signature, re-run the SSRF guard.
  assertUpstreamAllowed(url, loadConfig().allowPrivateUpstreams);
  return { url, headers: lookupHeaders(h) as UpstreamHeaders | undefined };
}
