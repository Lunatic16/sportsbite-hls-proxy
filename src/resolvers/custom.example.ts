/**
 * EXAMPLE: writing a custom (scraper/token-based) resolver.
 *
 * This file is documentation, not auto-registered. To add your own resolver:
 *
 *   1. Copy this pattern into `src/resolvers/mySite.ts`.
 *   2. Import it in `src/resolvers/index.ts` and call
 *      `registerResolver('mySite', mySiteResolver)`.
 *   3. Point a channel at it in channels.json:
 *
 *        {
 *          "id": "some-site-channel",
 *          "name": "Some Site Channel",
 *          "resolver": "custom",
 *          "options": { "custom": "mySite" }
 *        }
 *
 * Contract: resolve() is called lazily on play (never at startup), may do
 * anything async (fetch embed pages, mint tokens, scrape HTML) and returns
 * the direct upstream URL plus any headers the origin requires. Returning
 * `expiresAt` makes the proxy re-resolve automatically when the token is
 * stale or the upstream answers 403/404/410.
 *
 * The built-in `sportsbite` resolver (src/resolvers/sportsbite.ts) is a real,
 * working example: it derives the stream URL from the channel id prefix and
 * requires nothing but a Firefox User-Agent.
 */
import type { Channel, ResolvedStream } from '../channels/types.js';
import { ResolverError } from '../channels/types.js';
import type { Resolver } from './types.js';

export const exampleResolver: Resolver = {
  name: 'example',

  async resolve(channel: Channel): Promise<ResolvedStream> {
    // e.g. fetch the embed page, extract the media URL / token:
    //
    //   const page = await fetch(`https://example.tv/embed/${channel.id}`);
    //   const html = await page.text();
    //   const m = html.match(/source\s*=\s*atob\("([^"]+)"\)/);
    //   if (!m) throw new ResolverError('embed page changed', true);
    //   const url = Buffer.from(m[1], 'base64').toString('utf8');
    //   return { url, headers: { 'user-agent': FIREFOX_UA }, expiresAt: Date.now() + 3600_000 };
    //
    throw new ResolverError(`example resolver is documentation only (channel "${channel.id}")`, false);
  },
};
