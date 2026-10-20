/**
 * Generic proxy endpoints:
 *   GET /proxy/playlist?url=<b64url>&h=<headersId>&s=<sig>  → rewritten playlist
 *   GET /proxy/segment ?url=...&h=...&s=...                 → streamed segment
 *   GET /proxy/key     ?url=...&h=...&s=...                 → encryption key
 *
 * These routes are authenticated by the HMAC signature (`s`) — no AUTH_TOKEN
 * needed, and the browser never talks to the upstream directly. The SSRF
 * guard re-validates every URL even when the signature is valid.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { loadConfig } from '../config.js';
import { decodeUrlForProxy, verifyProxyUrl, type ProxyKind } from '../net/sign.js';
import { lookupHeaders } from '../net/headerRegistry.js';
import {
  fetchUpstream,
  readBodyWithCap,
  UpstreamError,
  type UpstreamHeaders,
} from '../net/fetchUpstream.js';
import { assertUpstreamAllowed } from '../net/ssrf.js';
import { mimeForKey, mimeForSegment } from '../hls/mime.js';
import { fetchAndRewritePlaylist, cacheControlFor } from '../hls/playlistService.js';
import { ByteLimitedCache } from '../util/cache.js';
import { getLogger, shortUpstream } from '../util/logger.js';
import { abortOnClientClose, publicBase } from '../util/http.js';
import { detectSegmentKind, decodeSegment } from '../hls/unwrap.js';

export class ProxyAuthError extends Error {}

function corsValues(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  };
}

function sendProxyError(reply: FastifyReply, status: number, message: string): void {
  void reply
    .header('cache-control', 'no-store')
    .header('retry-after', '2')
    .header('access-control-allow-origin', '*')
    .code(status)
    .send({ error: message });
}

function verifyRequest(
  req: FastifyRequest,
  kind: ProxyKind,
): { url: string; headers: UpstreamHeaders | undefined } {
  const q = (req.query ?? {}) as { url?: string; h?: string; s?: string };
  if (!q.url || !q.s) throw new ProxyAuthError('missing url or signature');
  if (!verifyProxyUrl(kind, q.url, q.h ?? 'none', q.s)) {
    throw new ProxyAuthError('invalid signature');
  }
  const url = decodeUrlForProxy(q.url);
  // Defense in depth: even with a valid signature, re-run the SSRF guard.
  assertUpstreamAllowed(url, loadConfig().allowPrivateUpstreams);
  return { url, headers: lookupHeaders(q.h) };
}

export function registerProxyRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.options('/proxy/*', async (_req, reply) => {
    void reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', 'GET, OPTIONS')
      .header('access-control-allow-headers', '*')
      .code(204)
      .send();
  });

  // ── playlist ──────────────────────────────────────────────────────────────
  app.get('/proxy/playlist', async (req, reply) => {
    let target: { url: string; headers: UpstreamHeaders | undefined };
    try {
      target = verifyRequest(req, 'playlist');
    } catch (err) {
      return sendProxyError(reply, err instanceof ProxyAuthError ? 403 : 400, (err as Error).message);
    }

    const abort = abortOnClientClose(req);
    try {
      const result = await fetchAndRewritePlaylist(target.url, {
        headers: target.headers as Record<string, string> | undefined,
        signal: abort.signal,
        origin: publicBase(req),
      });
      if (!result.ok) {
        return sendProxyError(reply, result.status, result.error ?? 'playlist fetch failed');
      }
      void reply
        .header('content-type', result.contentType ?? 'application/vnd.apple.mpegurl')
        .header('cache-control', cacheControlFor(result.isVod))
        .header('access-control-allow-origin', '*');
      return reply.send(result.text);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return reply;
      log.warn({ err: (err as Error).message, upstream: shortUpstream(target.url) }, 'proxy playlist error');
      return sendProxyError(reply, 502, 'playlist fetch failed');
    } finally {
      abort.dispose();
    }
  });

  // ── key ───────────────────────────────────────────────────────────────────
  app.get('/proxy/key', async (req, reply) => {
    let target: { url: string; headers: UpstreamHeaders | undefined };
    try {
      target = verifyRequest(req, 'key');
    } catch (err) {
      return sendProxyError(reply, err instanceof ProxyAuthError ? 403 : 400, (err as Error).message);
    }
    const abort = abortOnClientClose(req);
    try {
      const res = await fetchUpstream(target.url, { headers: target.headers, signal: abort.signal });
      if (res.status !== 200) {
        await res.body.dump().catch(() => {});
        return sendProxyError(reply, 502, `key upstream returned HTTP ${res.status}`);
      }
      const cfg = loadConfig();
      const buf = await readBodyWithCap(res.body, Math.min(cfg.upstreamMaxBodyMb, 2) * 1024 * 1024, abort.signal);
      void reply
        .header('content-type', mimeForKey())
        .header('content-length', String(buf.length))
        .header('cache-control', 'no-store')
        .header('access-control-allow-origin', '*');
      return reply.send(buf);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return reply;
      log.warn({ err: (err as Error).message, upstream: shortUpstream(target.url) }, 'proxy key error');
      return sendProxyError(reply, 502, 'key fetch failed');
    } finally {
      abort.dispose();
    }
  });

  // ── segment ───────────────────────────────────────────────────────────────
  app.get('/proxy/segment', async (req, reply) => {
    let target: { url: string; headers: UpstreamHeaders | undefined };
    try {
      target = verifyRequest(req, 'segment');
    } catch (err) {
      return sendProxyError(reply, err instanceof ProxyAuthError ? 403 : 400, (err as Error).message);
    }
    const abort = abortOnClientClose(req);
    const started = Date.now();
    try {
      await serveSegment(req, reply, target.url, target.headers, abort.signal);
      log.debug({ upstream: shortUpstream(target.url), ms: Date.now() - started }, 'segment served');
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        log.debug({ upstream: shortUpstream(target.url) }, 'segment aborted (client gone)');
        return reply;
      }
      if (err instanceof UpstreamError) {
        return sendProxyError(reply, 502, `segment upstream returned ${err.status ?? 'error'}`);
      }
      log.warn({ err: (err as Error).message, upstream: shortUpstream(target.url) }, 'proxy segment error');
      return sendProxyError(reply, 502, 'segment fetch failed');
    } finally {
      abort.dispose();
    }
  });
}

// Optional micro-cache for fully-buffered (decoded) segments so a retrying
// player doesn't hammer the CDN; upstream URLs die fast, entries drop on TTL.
const segCache = new ByteLimitedCache<{ buf: Buffer; contentType: string }>(
  loadConfig().segCacheMaxMb * 1024 * 1024,
  loadConfig().segCacheTtlMs,
);

const PEEK_BYTES = 64 * 1024;

type RawHeaders = Record<string, string | number | string[] | undefined>;

async function serveSegment(
  req: FastifyRequest,
  reply: FastifyReply,
  url: string,
  headers: UpstreamHeaders | undefined,
  signal: AbortSignal,
): Promise<void> {
  const cfg = loadConfig();

  if (cfg.segCacheTtlMs > 0) {
    const hit = segCache.get(url);
    if (hit) {
      void reply
        .header('content-type', hit.contentType)
        .header('content-length', String(hit.buf.length))
        .header('accept-ranges', 'none')
        .header('cache-control', 'no-store')
        .header('access-control-allow-origin', '*');
      return void reply.send(hit.buf);
    }
  }

  const range = req.headers.range;
  // Range must survive even when the channel has no header set (BYTERANGE
  // playlists depend on it).
  const upstreamHeaders: UpstreamHeaders | undefined = headers || range
    ? { ...(headers ?? {}), ...(range ? { range } : {}) }
    : undefined;
  const res = await fetchUpstream(url, {
    headers: upstreamHeaders,
    signal,
  });

  const contentType = mimeForSegment(url, res.headers['content-type']);
  const baseHeaders: RawHeaders = {
    'cache-control': 'no-store',
    ...corsValues(),
  };

  let status = 200;
  if (res.status === 206) {
    status = 206;
    baseHeaders['accept-ranges'] = res.headers['accept-ranges'] ?? 'bytes';
    if (res.headers['content-range']) baseHeaders['content-range'] = res.headers['content-range'];
  } else if (res.status !== 200) {
    await res.body.dump().catch(() => {});
    throw new UpstreamError(`upstream status ${res.status}`, res.status);
  } else {
    baseHeaders['accept-ranges'] = res.headers['accept-ranges'] ?? 'bytes';
  }

  // Peek at the first chunk to classify the payload: raw TS streams through
  // untouched; image-wrapped (timst) segments are buffered + decoded.
  const head = await readUpTo(res.body, PEEK_BYTES, signal);
  const kind = detectSegmentKind(head);

  if (kind === 'image-wrapped') {
    const maxBuf = cfg.unwrapMaxBufferMb * 1024 * 1024;
    let rest: Buffer;
    try {
      rest = await readBodyWithCap(res.body, maxBuf, signal);
    } catch (err) {
      await res.body.dump().catch(() => {});
      throw err;
    }
    const full = Buffer.concat([head, rest]);
    const decoded = decodeSegment(full);
    if (cfg.segCacheTtlMs > 0) {
      segCache.set(url, { buf: decoded, contentType: 'video/mp2t' }, decoded.length);
    }
    void reply
      .code(200)
      .header('content-type', 'video/mp2t')
      .header('content-length', String(decoded.length))
      .header('accept-ranges', 'none')
      .header('access-control-allow-origin', '*');
    return void reply.send(decoded);
  }

  // Raw / fMP4 / unknown: stream straight through — never fully buffered.
  baseHeaders['content-type'] = contentType;
  const upstreamLen = res.headers['content-length'];
  if (upstreamLen) {
    // Covers head + remainder for both 200 and 206 responses.
    baseHeaders['content-length'] = upstreamLen;
  }

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(status, baseHeaders);
  raw.write(head);

  await new Promise<void>((resolve) => {
    const src = res.body;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      src.off('error', onSrcError);
      raw.off('error', onRawError);
      raw.off('close', onRawClose);
      resolve();
    };
    function onSrcError(): void {
      // Upstream died mid-segment: close the response so the player retries.
      if (!raw.writableEnded) raw.end();
      finish();
    }
    function onRawError(): void {
      // Client write failed: drain (never destroy() an unconsumed body —
      // it emits an async AbortError that becomes an unhandled rejection).
      src.dump().catch(() => {});
      finish();
    }
    function onRawClose(): void {
      if (!raw.writableEnded) {
        src.dump().catch(() => {}); // viewer left — stop pulling upstream
      }
      finish();
    }
    src.on('error', onSrcError);
    raw.on('error', onRawError);
    raw.on('close', onRawClose);
    const dest = src.pipe(raw);
    dest.on('finish', finish);
  });
}

/** Read up to `max` bytes without losing a byte of the remainder. */
async function readUpTo(
  body: NodeJS.ReadableStream,
  max: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const onData = (chunk: Uint8Array | Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= max) finish();
    };
    const onEnd = () => finish();
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      cleanup();
      (body as NodeJS.ReadableStream & { destroy?: (e?: Error) => void }).destroy?.();
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    function cleanup(): void {
      if (done) return;
      done = true;
      body.off('data', onData);
      body.off('end', onEnd);
      body.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    }
    function finish(): void {
      if (done) return;
      // Removing the 'data' listener returns the stream to paused mode; the
      // caller consumes the remainder directly (pipe / for-await).
      cleanup();
      resolve(Buffer.concat(chunks));
    }
    body.on('data', onData);
    body.on('end', onEnd);
    body.on('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
