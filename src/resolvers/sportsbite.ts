/**
 * Sportsbite resolver (the documented "custom" example).
 *
 * Derivation rules (verified 2026-10-19 against sportsbite.org, see the
 * project's upstream research notes / `sportsbite-player-context.md`):
 *
 *   id prefix `247-`  → https://sportsbite.org/247/<slug>   (livelive24)
 *   id prefix `t247-` → https://sportsbite.org/t247/<slug>  (timst)
 *   id prefix `cv-`   → https://sportsbite.org/cv/<slug>    (cinevid — DEAD upstream)
 *
 * The stream URL is stable and needs no tokens client-side; short-lived
 * tokens live inside segment URLs and are refreshed by the proxy re-fetching
 * the playlist on every request (live players re-poll anyway).
 *
 * Header rules:
 *  - A plain Firefox UA is enough everywhere.
 *  - NO Referer anywhere; TikTok's CDN (timst segments) 403s any request
 *    that carries one. The proxy additionally strips Referer per-host via
 *    STRIP_REFERER_HOSTS (default includes "tiktokcdn").
 *
 * cv-* channels currently return HTTP 503 {"error":"cinevid streamUrl
 * missing ..."} — the proxy surfaces that as a clean 502, and `npm run check`
 * marks them offline.
 */
import { ResolverError } from '../channels/types.js';
import type { Channel, ResolvedStream } from '../channels/types.js';
import type { Resolver } from './types.js';

const BASE = 'https://sportsbite.org';

const PREFIXES: Array<[prefix: string, path: string]> = [
  ['247-', '247'],
  ['t247-', 't247'],
  ['cv-', 'cv'],
];

export function deriveSportsbiteStreamUrl(channelId: string): string {
  for (const [prefix, path] of PREFIXES) {
    if (channelId.startsWith(prefix)) {
      const slug = channelId.slice(prefix.length);
      if (!slug) break;
      return `${BASE}/${path}/${encodeURIComponent(slug)}`;
    }
  }
  throw new ResolverError(`unknown sportsbite id prefix: "${channelId}" (expected 247- / t247- / cv-)`, false);
}

/** Long-ish TTL: the playlist URL is stable; segments rotate server-side. */
const RESOLVE_TTL_MS = 15 * 60 * 1000;

export const sportsbiteResolver: Resolver = {
  name: 'sportsbite',

  async resolve(channel: Channel): Promise<ResolvedStream> {
    // Explicit overrides win (e.g. channels.json sets options.url).
    const override = channel.options?.['url'];
    if (typeof override === 'string' && override) {
      return {
        url: override,
        headers: { 'user-agent': channel.headers?.['user-agent'] ?? defaultUa(channel) },
        expiresAt: Date.now() + RESOLVE_TTL_MS,
      };
    }
    const url = deriveSportsbiteStreamUrl(channel.id);
    const resolved: ResolvedStream = {
      url,
      headers: { 'user-agent': defaultUa(channel) },
      expiresAt: Date.now() + RESOLVE_TTL_MS,
    };
    // Never attach Referer — upstream 403s on it (TikTok CDN) and it is not needed.
    delete resolved.headers?.referer;
    return resolved;
  },
};

function defaultUa(channel: Channel): string {
  return channel.headers?.['user-agent'] ?? channel.headers?.['User-Agent'] ??
    'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
}
