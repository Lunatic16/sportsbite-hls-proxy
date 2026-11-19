/**
 * Segment proxy service: streams (or decodes) an upstream media segment.
 *
 * Ported from the Fastify `reply.hijack()` implementation to a plain
 * `Response` factory for Next.js route handlers:
 *  - Raw / fMP4 / unknown segments stream through — never fully buffered.
 *  - Image-wrapped (timst) segments are buffered, decoded to clean MPEG-TS
 *    and served as `video/mp2t`.
 *  - The first 64KB are peeked (without losing a byte) to classify the
 *    payload per response — the wrapper is never assumed per channel.
 *
 * Every late upstream error is swallowed on purpose: an aborted segment
 * request is normal (viewer switched channels), and one stray rejection must
 * never take the whole server down.
 */
import { PassThrough } from 'node:stream';
import { Readable } from 'node:stream';
import { loadConfig } from './config';
import { detectSegmentKind, decodeSegment } from './unwrap';
import { mimeForSegment } from './mime';
import { ByteLimitedCache } from './cache';
import { fetchUpstream, readBodyWithCap, UpstreamError, type UpstreamHeaders } from './fetchUpstream';
import { getLogger, shortUpstream } from './logger';

interface CachedSegment {
  buf: Buffer;
  contentType: string;
}

interface GlobalState {
  __iptvSegCache?: ByteLimitedCache<CachedSegment>;
}

const g = globalThis as unknown as GlobalState;

function segCache(): ByteLimitedCache<CachedSegment> {
  if (!g.__iptvSegCache) {
    const cfg = loadConfig();
    g.__iptvSegCache = new ByteLimitedCache<CachedSegment>(cfg.segCacheMaxMb * 1024 * 1024, cfg.segCacheTtlMs);
  }
  return g.__iptvSegCache;
}

export function clearSegmentCache(): void {
  segCache().clear();
}

export function segmentCacheStats(): { entries: number; bytes: number } {
  const c = segCache();
  return { entries: c.size, bytes: c.bytes };
}

const PEEK_BYTES = 64 * 1024;

export class SegmentUpstreamError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'SegmentUpstreamError';
  }
}

export interface SegmentResult {
  status: number;
  headers: Record<string, string>;
  /** Fully-buffered payload (cache hit / decoded segment). */
  buffer?: Buffer;
  /** Streamed payload (mutually exclusive with `buffer`). */
  stream?: ReadableStream<Uint8Array>;
}

/**
 * Read up to `max` bytes without losing a byte of the remainder. After it
 * resolves, `body` is in paused mode and the caller can pipe/consume the
 * rest of the stream.
 */
async function readUpTo(
  body: NodeJS.ReadableStream,
  max: number,
  signal?: AbortSignal,
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
      signal?.removeEventListener('abort', onAbort);
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
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Fetch a segment from `url` and prepare the response pieces.
 * Throws SegmentUpstreamError (with status) on non-2xx upstream responses
 * and UpstreamError on network failures.
 */
export async function fetchSegment(
  url: string,
  headers: UpstreamHeaders | undefined,
  range: string | undefined,
  signal: AbortSignal | undefined,
): Promise<SegmentResult> {
  const cfg = loadConfig();

  if (cfg.segCacheTtlMs > 0) {
    const hit = segCache().get(url);
    if (hit) {
      return {
        status: 200,
        headers: {
          'content-type': hit.contentType,
          'content-length': String(hit.buf.length),
          'accept-ranges': 'none',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        },
        buffer: hit.buf,
      };
    }
  }

  // Range must survive even when the channel has no header set (BYTERANGE
  // playlists depend on it).
  const upstreamHeaders: UpstreamHeaders | undefined = headers || range
    ? { ...(headers ?? {}), ...(range ? { range } : {}) }
    : undefined;
  const res = await fetchUpstream(url, { headers: upstreamHeaders, signal });

  const contentType = mimeForSegment(url, res.headers['content-type']);
  const baseHeaders: Record<string, string> = {
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
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
      segCache().set(url, { buf: decoded, contentType: 'video/mp2t' }, decoded.length);
    }
    return {
      status: 200,
      headers: {
        'content-type': 'video/mp2t',
        'content-length': String(decoded.length),
        'accept-ranges': 'none',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      },
      buffer: decoded,
    };
  }

  // Raw / fMP4 / unknown: stream straight through — never fully buffered.
  baseHeaders['content-type'] = contentType;
  const upstreamLen = res.headers['content-length'];
  if (upstreamLen) {
    // Covers head + remainder for both 200 and 206 responses.
    baseHeaders['content-length'] = upstreamLen;
  }

  // Swallow late upstream errors: client disconnects mid-segment are normal.
  res.body.on('error', () => {});

  const pt = new PassThrough();
  pt.write(head);
  void pipelineUpstream(res.body, pt, signal);
  const webStream = Readable.toWeb(pt) as unknown as ReadableStream<Uint8Array>;

  return { status, headers: baseHeaders, stream: webStream };
}

/** Pipe upstream remainder into the passthrough; resolve (never throw). */
function pipelineUpstream(
  src: NodeJS.ReadableStream,
  dest: PassThrough,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onSrcError = () => {
      if (!dest.writableEnded) dest.end();
      finish();
    };
    const onDestError = () => {
      // Client write failed: drain (never destroy() an unconsumed body —
      // it emits an async AbortError that becomes an unhandled rejection).
      (src as NodeJS.ReadableStream & { dump?: () => Promise<void> }).dump?.().catch(() => {});
      finish();
    };
    const onDestClose = () => {
      if (!dest.writableEnded) {
        (src as NodeJS.ReadableStream & { dump?: () => Promise<void> }).dump?.().catch(() => {});
      }
      finish();
    };
    const onAbort = () => {
      (src as NodeJS.ReadableStream & { dump?: () => Promise<void> }).dump?.().catch(() => {});
      finish();
    };
    function cleanup(): void {
      src.off('error', onSrcError);
      dest.off('error', onDestError);
      dest.off('close', onDestClose);
      signal?.removeEventListener('abort', onAbort);
    }
    src.on('error', onSrcError);
    dest.on('error', onDestError);
    dest.on('close', onDestClose);
    signal?.addEventListener('abort', onAbort, { once: true });
    const piped = src.pipe(dest);
    piped.on('finish', finish);
  });
}

/** Log-friendly one-liner for segment proxy failures. */
export function logSegmentError(url: string, err: unknown): void {
  const log = getLogger();
  if ((err as Error).name === 'AbortError') {
    log.debug({ upstream: shortUpstream(url) }, 'segment aborted (client gone)');
    return;
  }
  log.warn({ err: (err as Error).message, upstream: shortUpstream(url) }, 'proxy segment error');
}
