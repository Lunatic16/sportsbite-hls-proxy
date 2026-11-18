/**
 * Matchora resolver — streams behind sportsbite.org's `xm-` source.
 *
 * Research notes (verified live 2026-11-18 against sportsbite.org + matchora.to):
 *
 *  - The catalog (`https://sportsbite.org/channels`) lists `xm-<id>` channels
 *    whose `manifest_url` is an EMBED PAGE: `https://sportsbite.org/xm-embed/embed/<id>`.
 *  - That embed page requires `Referer: https://sportsbite.org/` (otherwise it
 *    302s to the homepage) and is a tiny shell that iframes
 *    `https://matchora.to/embed/channel/<id>`.
 *  - The matchora embed page (Referer-restricted the same way) embeds a pass
 *    token in its HTML: `var PP="<token>"` (tokens starting with `_` are
 *    placeholders and must be skipped — same regex the player itself uses).
 *  - The real playlist URL comes from
 *      GET https://matchora.to/api/play/<id>?pp=<token>
 *    with `Accept: application/json` and a matchora (or empty) Referer — a
 *    sportsbite.org Referer is explicitly rejected ("use the embed").
 *    Response: `{ ready, reason, url, expires_in, pp }` where `pp` is a
 *    RENEWED pass token to use for subsequent calls.
 *  - `reason: "pass"` (HTTP 403) means the token went stale: re-read the
 *    embed page and retry. `reason: "warming"|"capacity"` still returns a
 *    URL, but the edge answers 404 "warming" until the channel is hot — the
 *    proxy re-resolves on 404 and players re-poll, so playback starts once
 *    the edge wakes up (a few seconds, same as in the site's own player).
 *  - The playlist URL itself (edge host, rotates — e.g. e.biboguv.cyou) needs
 *    any non-empty User-Agent and no Referer; it expires in `expires_in`
 *    (600 s today) and is renewed through the same call chain.
 *  - Alt API origin `https://matchora.pro` mirrors `.to` (the player swaps on
 *    repeated API errors).
 */
import type { Channel, ResolvedStream } from '../channels/types.js';
import { ResolverError } from '../channels/types.js';
import type { Resolver } from './types.js';
import { loadConfig } from '../config.js';
import { fetchUpstream, readBodyWithCap, UpstreamError } from '../net/fetchUpstream.js';

/** The site's embed pages demand a sportsbite.org Referer; the API forbids it. */
const EMBED_HEADERS = {
  referer: 'https://sportsbite.org/',
} as const;

const API_HEADERS = {
  accept: 'application/json',
  referer: 'https://matchora.to/',
} as const;

/** Alt API origins — the player swaps to the mirror on repeated API errors. */
const API_BASES = ['https://matchora.to', 'https://matchora.pro'];

/** Same guard the player uses: skip placeholder tokens (`var PP="_..."`). */
export function parseMatchoraEmbedPp(html: string): string {
  const m = html.match(/var PP="([^"_][^"]*)"/);
  if (!m) {
    throw new ResolverError('matchora embed page did not carry a pass token (upstream layout changed?)', true);
  }
  return m[1];
}

export function matchoraChannelId(channel: Channel): string {
  const fromOptions = channel.options?.['sourceId'];
  if (typeof fromOptions === 'string' && /^xm-\d+$/i.test(fromOptions)) {
    return String(fromOptions).slice(3);
  }
  if (channel.tvgId && /^xm-\d+$/i.test(channel.tvgId)) {
    return channel.tvgId.slice(3);
  }
  if (/^xm-\d+$/i.test(channel.id)) {
    return channel.id.slice(3);
  }
  throw new ResolverError(`channel "${channel.id}" is not a matchora (xm-<digits>) channel`, false);
}

interface MatchoraPlayResponse {
  ready?: boolean;
  reason?: string;
  url?: string;
  expires_in?: number;
  pp?: string;
  error?: string;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: MatchoraPlayResponse }> {
  const cfg = loadConfig();
  const res = await fetchUpstream(url, { headers, timeoutMs: Math.min(cfg.resolveTimeoutMs, 8000) });
  const text = (await readBodyWithCap(res.body, 256 * 1024)).toString('utf8');
  let body: MatchoraPlayResponse;
  try {
    body = JSON.parse(text) as MatchoraPlayResponse;
  } catch {
    throw new ResolverError(`matchora API returned non-JSON (HTTP ${res.status})`, true);
  }
  return { status: res.status, body };
}

async function fetchEmbedPage(apiBase: string, chId: string): Promise<string> {
  const cfg = loadConfig();
  const res = await fetchUpstream(`${apiBase}/embed/channel/${encodeURIComponent(chId)}`, {
    headers: EMBED_HEADERS,
    timeoutMs: Math.min(cfg.resolveTimeoutMs, 8000),
  });
  if (res.status !== 200) {
    await res.body.dump().catch(() => {});
    throw new ResolverError(`matchora embed page returned HTTP ${res.status}`, true);
  }
  return (await readBodyWithCap(res.body, 512 * 1024)).toString('utf8');
}

/**
 * One full resolution round: embed page → pass token → /api/play.
 * Returns the stream URL + TTL, or null when the upstream says the channel
 * is not currently served (warming / capacity with no URL / verify gate).
 */
async function resolveOnce(chId: string, apiBase: string): Promise<ResolvedStream | null> {
  const html = await fetchEmbedPage(apiBase, chId);
  let pp = parseMatchoraEmbedPp(html);

  for (let attempt = 0; attempt < 2; attempt++) {
    const { status, body } = await fetchJson(
      `${apiBase}/api/play/${encodeURIComponent(chId)}?pp=${encodeURIComponent(pp)}`,
      API_HEADERS,
    );
    if (body.pp) pp = body.pp;

    if (body.url) {
      const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 30 ? body.expires_in : 300;
      // Renew well before the token actually lapses.
      const ttlMs = Math.max(60_000, (expiresIn - 60) * 1000);
      return {
        url: body.url,
        headers: { 'user-agent': loadConfig().userAgent },
        expiresAt: Date.now() + ttlMs,
      };
    }

    // Stale/absent pass token: the player re-reads the same page. One retry,
    // then give up and let the routes' retry ladder handle it.
    if (body.reason === 'pass' || status === 403) {
      const freshHtml = await fetchEmbedPage(apiBase, chId);
      pp = parseMatchoraEmbedPp(freshHtml);
      continue;
    }

    if (body.error) {
      throw new ResolverError(`matchora API: ${body.error}`, false);
    }
    // warming / capacity / verify without a URL: retryable, surface clearly.
    throw new ResolverError(
      `matchora upstream not ready (reason: ${body.reason ?? status}) — the channel is warming up, retry shortly`,
      true,
    );
  }
  throw new ResolverError('matchora pass token kept going stale (reason: pass)', true);
}

/** Long-ish TTL is set per-response from `expires_in`; this is only a fallback. */
const FALLBACK_TTL_MS = 4 * 60 * 1000;

export const matchoraResolver: Resolver = {
  name: 'matchora',

  async resolve(channel: Channel): Promise<ResolvedStream> {
    // Explicit overrides win (e.g. channels.json sets options.url).
    const override = channel.options?.['url'];
    if (typeof override === 'string' && override) {
      return {
        url: override,
        headers: { 'user-agent': channel.headers?.['user-agent'] ?? loadConfig().userAgent },
        expiresAt: Date.now() + FALLBACK_TTL_MS,
      };
    }

    const chId = matchoraChannelId(channel);
    let lastErr: unknown;
    for (const apiBase of API_BASES) {
      try {
        const resolved = await resolveOnce(chId, apiBase);
        if (resolved) return resolved;
      } catch (err) {
        lastErr = err;
        if (err instanceof UpstreamError) continue; // try the alt origin
        throw err;
      }
    }
    if (lastErr instanceof Error) throw lastErr;
    throw new ResolverError('matchora resolution failed', true);
  },
};
