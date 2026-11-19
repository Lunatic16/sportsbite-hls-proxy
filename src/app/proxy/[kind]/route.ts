/**
 * Generic proxy endpoints (signed URLs — no AUTH_TOKEN needed, the browser
 * never talks to the upstream directly):
 *   GET /proxy/playlist?url=<b64url>&h=<headersId>&s=<sig>  → rewritten playlist
 *   GET /proxy/segment ?url=...&h=...&s=...                 → streamed segment
 *   GET /proxy/key     ?url=...&h=...&s=...                 → encryption key
 *
 * The SSRF guard re-validates every URL even when the signature is valid.
 */
import { NextRequest } from 'next/server';
import { loadConfig } from '@/server/config';
import { ProxyAuthError, verifyProxyRequest, corsHeaders, jsonError } from '@/server/proxyVerify';
import {
  fetchUpstream,
  readBodyWithCap,
  UpstreamError,
} from '@/server/fetchUpstream';
import { mimeForKey } from '@/server/mime';
import { fetchAndRewritePlaylist, cacheControlFor } from '@/server/playlistService';
import { fetchSegment, logSegmentError, SegmentUpstreamError } from '@/server/segmentService';
import { getLogger, shortUpstream } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(),
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': '*',
    },
  });
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ kind: string }> }) {
  const log = getLogger();
  const { kind: rawKind } = await ctx.params;
  const kind = rawKind as 'playlist' | 'segment' | 'key';
  if (kind !== 'playlist' && kind !== 'segment' && kind !== 'key') {
    return jsonError(404, `no route: /proxy/${rawKind}`);
  }

  let target: { url: string; headers: import('@/server/fetchUpstream').UpstreamHeaders | undefined };
  try {
    target = verifyProxyRequest(req, kind);
  } catch (err) {
    return jsonError(err instanceof ProxyAuthError ? 403 : 400, (err as Error).message);
  }

  // ── playlist ────────────────────────────────────────────────────────────
  if (kind === 'playlist') {
    try {
      const result = await fetchAndRewritePlaylist(target.url, {
        headers: target.headers as Record<string, string> | undefined,
        signal: req.signal,
        origin: new URL(req.url).origin,
      });
      if (!result.ok) {
        return jsonError(result.status, result.error ?? 'playlist fetch failed', { 'retry-after': '2' });
      }
      return new Response(result.text, {
        status: 200,
        headers: {
          'content-type': result.contentType ?? 'application/vnd.apple.mpegurl',
          'cache-control': cacheControlFor(result.isVod),
          ...corsHeaders(),
        },
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return new Response(null, { status: 499, statusText: 'Client Closed Request' });
      }
      log.warn({ err: (err as Error).message, upstream: shortUpstream(target.url) }, 'proxy playlist error');
      return jsonError(502, 'playlist fetch failed', { 'retry-after': '2' });
    }
  }

  // ── key ─────────────────────────────────────────────────────────────────
  if (kind === 'key') {
    try {
      const res = await fetchUpstream(target.url, { headers: target.headers, signal: req.signal });
      if (res.status !== 200) {
        await res.body.dump().catch(() => {});
        return jsonError(502, `key upstream returned HTTP ${res.status}`);
      }
      const cfg = loadConfig();
      const buf = await readBodyWithCap(res.body, Math.min(cfg.upstreamMaxBodyMb, 2) * 1024 * 1024, req.signal);
      return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
          'content-type': mimeForKey(),
          'content-length': String(buf.length),
          'cache-control': 'no-store',
          ...corsHeaders(),
        },
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return new Response(null, { status: 499, statusText: 'Client Closed Request' });
      }
      log.warn({ err: (err as Error).message, upstream: shortUpstream(target.url) }, 'proxy key error');
      return jsonError(502, 'key fetch failed');
    }
  }

  // ── segment ─────────────────────────────────────────────────────────────
  try {
    const seg = await fetchSegment(
      target.url,
      target.headers,
      req.headers.get('range') ?? undefined,
      req.signal,
    );
    if (seg.buffer) {
      return new Response(new Uint8Array(seg.buffer), { status: seg.status, headers: seg.headers });
    }
    return new Response(seg.stream, { status: seg.status, headers: seg.headers });
  } catch (err) {
    logSegmentError(target.url, err);
    if (err instanceof UpstreamError) {
      return jsonError(502, `segment upstream returned ${err.status ?? 'error'}`, { 'retry-after': '2' });
    }
    if (err instanceof SegmentUpstreamError) {
      return jsonError(err.status ?? 502, err.message, { 'retry-after': '2' });
    }
    if ((err as Error).name === 'AbortError') {
      return new Response(null, { status: 499, statusText: 'Client Closed Request' });
    }
    return jsonError(502, 'segment fetch failed', { 'retry-after': '2' });
  }
}
