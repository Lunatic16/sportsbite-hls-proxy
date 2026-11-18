/**
 * Sportsbite resolver (the documented "custom" example).
 *
 * Derivation rules (verified 2026-11-18 against sportsbite.org):
 *
 *   id prefix `247-`  → https://sportsbite.org/247/<slug>   (direct M3U8)
 *   id prefix `t247-` → https://sportsbite.org/t247/<slug>  (timst — DEAD upstream,
 *                                                      now 404 "not found")
 *   id prefix `cv-`   → https://sportsbite.org/cv/<slug>    (cinevid — DEAD upstream,
 *                                                      now 410 "source removed")
 *   id prefix `xm-`   → matchora resolver (see ./matchora.ts) — the `xm-*`
 *                                                      family is played through
 *                                                      matchora.to embed pages
 *
 * The `247-` stream URL is stable and needs no tokens client-side; short-lived
 * tokens live inside segment URLs and are refreshed by the proxy re-fetching
 * the playlist on every request (live players re-poll anyway). The upstream
 * requires a browser-like User-Agent (nginx 403s an empty one).
 *
 * Header rules:
 *  - A plain Firefox UA is enough for the `247-` family.
 *  - NO Referer for the `247-` family; TikTok's CDN (old timst segments) 403s
 *    any request that carries one. The proxy additionally strips Referer
 *    per-host via STRIP_REFERER_HOSTS (default includes "tiktokcdn").
 *  - The `xm-` family is resolved (and streamed) through the matchora chain —
 *    see ./matchora.ts for the full protocol.
 */
import { ResolverError } from '../channels/types.js';
import type { Channel, ResolvedStream } from '../channels/types.js';
import type { Resolver } from './types.js';
import { matchoraResolver } from './matchora.js';

const BASE = 'https://sportsbite.org';

const PREFIXES: Array<[prefix: string, path: string]> = [
  ['247-', '247'],
  ['t247-', 't247'],
  ['cv-', 'cv'],
  // xm- is handled separately above: it maps to /xm-embed/embed/<digits> and
  // resolves through the matchora resolver.
];

export function deriveSportsbiteStreamUrl(channelId: string): string {
  // xm- ids are numeric matchora channel ids — reject anything else so the
  // import guard drops malformed entries instead of failing at play time.
  if (/^xm-/i.test(channelId)) {
    if (/^xm-\d+$/i.test(channelId)) {
      return `${BASE}/xm-embed/embed/${channelId.slice(3)}`;
    }
    throw new ResolverError(`invalid matchora id: "${channelId}" (expected xm-<digits>)`, false);
  }
  for (const [prefix, path] of PREFIXES) {
    if (channelId.startsWith(prefix)) {
      const slug = channelId.slice(prefix.length);
      if (!slug) break;
      return `${BASE}/${path}/${encodeURIComponent(slug)}`;
    }
  }
  throw new ResolverError(`unknown sportsbite id prefix: "${channelId}" (expected 247- / t247- / cv- / xm-)`, false);
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
    // The xm- family plays through matchora, not a derivable direct URL —
    // delegate so older channels.json entries pointing at this resolver keep
    // working.
    if (/^xm-\d+/i.test(channel.id) || /^xm-\d+/i.test(channel.tvgId ?? '')) {
      return matchoraResolver.resolve(channel);
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
