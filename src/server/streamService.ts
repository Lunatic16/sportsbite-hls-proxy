/**
 * Channel playlist serving shared by all entry points:
 *   GET /api/stream/:channelId(.m3u8) — canonical (used by the web UI)
 *   GET /stream/:channelId(.m3u8)     — same URL the generated M3U uses
 *   GET /live/:channelId              — share-friendly alias (no extension)
 *
 * Re-resolves the upstream URL whenever the cached one has expired or the
 * upstream answers 403/404/410, then retries once — so shared links never go
 * stale, and segment/key proxy URLs are re-issued on every playlist refresh.
 */
import type { NextRequest } from 'next/server';
import { store } from './channels/store';
import { checkChannelAccess } from './auth';
import { resolveAndFetch } from './resolvers';
import { fetchAndRewritePlaylist, cacheControlFor, type PlaylistFetchResult } from './playlistService';
import { getLogger, shortUpstream } from './logger';
import { publicBase } from './http';
import { jsonError, corsHeaders } from './proxyVerify';

export function normalizeChannelId(rawId: string): string {
  return rawId.replace(/\.m3u8$/i, '');
}

export async function serveChannelPlaylist(req: NextRequest, rawChannelId: string): Promise<Response> {
  const log = getLogger();
  const channelId = normalizeChannelId(decodeURIComponent(rawChannelId));
  const channel = store.get(channelId);

  const access = checkChannelAccess(req, channelId);
  if (!access.ok) {
    return jsonError(access.status, access.reason);
  }

  if (!channel) {
    return jsonError(404, `unknown channel "${channelId}"`);
  }

  try {
    const { resolved, result } = await resolveAndFetch(channel, async (r) => {
      const pr = await fetchAndRewritePlaylist(r.url, {
        headers: r.headers,
        signal: req.signal,
        origin: publicBase(req),
      });
      return { status: pr.upstreamStatus ?? (pr.ok ? 200 : 502), playlist: pr };
    });

    const r = result.playlist as PlaylistFetchResult;
    if (!r.ok) {
      log.info(
        { channelId: channel.id, upstream: shortUpstream(resolved.url), status: r.upstreamStatus },
        'channel playlist unavailable',
      );
      return jsonError(r.status, r.error ?? 'channel unavailable', { 'retry-after': '3' });
    }
    return new Response(r.text, {
      status: 200,
      headers: {
        'content-type': r.contentType ?? 'application/vnd.apple.mpegurl',
        'cache-control': cacheControlFor(r.isVod),
        'access-control-allow-origin': '*',
        ...corsHeaders(),
      },
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      return new Response(null, { status: 499, statusText: 'Client Closed Request' });
    }
    log.warn({ channelId: channel.id, err: (err as Error).message }, 'stream route error');
    return jsonError(502, `channel "${channelId}" failed: ${(err as Error).message}`);
  }
}
