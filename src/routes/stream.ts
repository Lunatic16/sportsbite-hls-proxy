/**
 * Per-channel stable entry points:
 *   GET /stream/:channelId(.m3u8)   — rewritten playlist (same URL the
 *                                     generated M3U uses; token-protected
 *                                     when SHARE_TOKEN_REQUIRED)
 *   GET /live/:channelId            — share-friendly alias (no extension)
 *
 * Both re-resolve the upstream URL whenever the cached one has expired or the
 * upstream answers 403/404/410, then retry once — so shared links never go
 * stale, and segment/key proxy URLs are re-issued on every playlist refresh.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../channels/store.js';
import { checkChannelAccess } from '../auth.js';
import { resolveAndFetch } from '../resolvers/index.js';
import { fetchAndRewritePlaylist, cacheControlFor, type PlaylistFetchResult } from '../hls/playlistService.js';
import { getLogger, shortUpstream } from '../util/logger.js';
import { abortOnClientClose, publicBase } from '../util/http.js';

export function normalizeChannelId(rawId: string): string {
  return rawId.replace(/\.m3u8$/i, '');
}

function authFailure(
  reply: FastifyReply,
  result: { ok: false; status: 401 | 403; reason: string },
): FastifyReply {
  void reply
    .header('access-control-allow-origin', '*')
    .code(result.status)
    .send({ error: result.reason });
  return reply;
}

export function registerStreamRoutes(app: FastifyInstance): void {
  const log = getLogger();

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const rawId = (req.params as { channelId: string }).channelId;
    const channelId = normalizeChannelId(decodeURIComponent(rawId));
    const channel = store.get(channelId);

    const access = checkChannelAccess(req, channelId);
    if (!access.ok) return authFailure(reply, access);

    if (!channel) {
      return void reply.code(404).send({ error: `unknown channel "${channelId}"` });
    }

    const abort = abortOnClientClose(req);
    try {
      const { resolved, result } = await resolveAndFetch(channel, async (r) => {
        const pr = await fetchAndRewritePlaylist(r.url, {
          headers: r.headers,
          signal: abort.signal,
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
        return void reply
          .code(r.status)
          .header('cache-control', 'no-store')
          .header('retry-after', '3')
          .send({ error: r.error ?? 'channel unavailable' });
      }
      void reply
        .code(200)
        .header('content-type', r.contentType ?? 'application/vnd.apple.mpegurl')
        .header('cache-control', cacheControlFor(r.isVod))
        .header('access-control-allow-origin', '*');
      return reply.send(r.text);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return reply;
      log.warn({ channelId: channel.id, err: (err as Error).message }, 'stream route error');
      return void reply.code(502).send({ error: `channel "${channelId}" failed: ${(err as Error).message}` });
    } finally {
      abort.dispose();
    }
  };

  app.get('/stream/:channelId', handler);
  app.get('/live/:channelId', handler);
}
