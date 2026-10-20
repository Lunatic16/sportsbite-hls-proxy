/**
 * Shared playlist pipeline used by both entry points (/stream/:id and
 * /proxy/playlist): fetch upstream (cached 1s for live, longer for VOD),
 * classify errors (JSON bodies, non-2xx), rewrite URIs to signed proxy URLs.
 */
import { loadConfig } from '../config.js';
import { rewritePlaylist, isVodPlaylist, isMasterPlaylist } from '../hls/parser.js';
import { mimeForPlaylist } from '../hls/mime.js';
import {
  fetchUpstream,
  readBodyWithCap,
  UpstreamError,
  type UpstreamHeaders,
} from '../net/fetchUpstream.js';
import { lookupHeaders, registerHeaders } from '../net/headerRegistry.js';
import { TtlLruCache } from '../util/cache.js';
import { getLogger, shortUpstream } from '../util/logger.js';

export interface PlaylistFetchResult {
  ok: boolean;
  status: number;
  /** Rewritten playlist text (ok) or a sanitized error message (!ok). */
  text?: string;
  contentType?: string;
  isVod?: boolean;
  isMaster?: boolean;
  upstreamStatus?: number;
  error?: string;
}

interface CacheEntry {
  result: PlaylistFetchResult;
}

const cache = new TtlLruCache<CacheEntry>(loadConfig().playlistCacheMax, 60_000);

export function playlistCacheKey(url: string, headersId: string): string {
  return `${headersId}|${url}`;
}

export function clearPlaylistCache(): void {
  cache.clear();
}

export interface FetchPlaylistOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Origin used to mint proxy URLs (from the client request). */
  origin: string;
}

export async function fetchAndRewritePlaylist(
  url: string,
  options: FetchPlaylistOptions,
): Promise<PlaylistFetchResult> {
  const cfg = loadConfig();
  const headersId = registerHeaders(options.headers);
  const key = playlistCacheKey(url, headersId);
  const cached = cache.get(key);
  if (cached) return cached.result;

  const result = await fetchPlaylistUncached(url, options, headersId, cfg.upstreamMaxBodyMb * 1024 * 1024);
  const ttl = result.isVod ? cfg.cacheTtlVodMs : cfg.cacheTtlPlaylistMs;
  cache.set(key, { result }, ttl);
  return result;
}

async function fetchPlaylistUncached(
  url: string,
  options: FetchPlaylistOptions,
  headersId: string,
  maxBodyBytes: number,
): Promise<PlaylistFetchResult> {
  const log = getLogger();
  const upstreamHeaders: UpstreamHeaders | undefined = options.headers
    ? (lookupHeaders(headersId) as UpstreamHeaders)
    : undefined;

  try {
    const res = await fetchUpstream(url, {
      headers: upstreamHeaders,
      signal: options.signal,
    });

    if (res.status !== 200) {
      await res.body.dump().catch(() => {});
      return {
        ok: false,
        status: 502,
        upstreamStatus: res.status,
        error: `upstream playlist returned HTTP ${res.status}`,
      };
    }

    const upstreamCt = res.headers['content-type'] ?? '';
    const body = await readBodyWithCap(res.body, maxBodyBytes, options.signal);
    const text = body.toString('utf8').replace(/^\uFEFF/, '');

    // Some upstreams answer 200 with a JSON error object (cinevid does this
    // with HTTP 503; others with 200). Detect and surface a clean message.
    if (!text.includes('#EXTM3U')) {
      const jsonErr = tryJsonError(text, upstreamCt);
      return {
        ok: false,
        status: 502,
        upstreamStatus: res.status,
        error: jsonErr ?? 'upstream did not return an M3U8 playlist',
      };
    }

    const isVod = isVodPlaylist(text);
    const rewritten = rewritePlaylist(text, res.finalUrl, options.headers, options.origin);

    log.debug(
      { upstream: shortUpstream(res.finalUrl), vod: isVod, master: isMasterPlaylist(text) },
      'playlist fetched + rewritten',
    );

    return {
      ok: true,
      status: 200,
      text: rewritten,
      contentType: mimeForPlaylist(),
      isVod,
      isMaster: isMasterPlaylist(text),
      upstreamStatus: 200,
    };
  } catch (err) {
    if (err instanceof UpstreamError) {
      return {
        ok: false,
        status: 502,
        upstreamStatus: err.status,
        error: `upstream playlist failed: ${err.message}`,
      };
    }
    if ((err as Error).name === 'AbortError') throw err; // client went away
    return { ok: false, status: 502, error: `playlist fetch error: ${(err as Error).message}` };
  }
}

function tryJsonError(text: string, contentType: string): string | undefined {
  const trimmed = text.trim();
  const looksJson = contentType.includes('json') || trimmed.startsWith('{') || trimmed.startsWith('[');
  if (!looksJson) return undefined;
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const msg = obj['error'] ?? obj['message'] ?? obj['detail'];
    if (typeof msg === 'string' && msg.length > 0) {
      return `upstream error: ${msg.slice(0, 200)}`;
    }
    return 'upstream returned a JSON error';
  } catch {
    return undefined;
  }
}

/** Cache-Control header for a playlist response. */
export function cacheControlFor(isVod: boolean | undefined): string {
  return isVod ? 'public, max-age=30' : 'no-store, must-revalidate';
}
