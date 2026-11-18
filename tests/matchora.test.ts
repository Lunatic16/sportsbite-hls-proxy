import { describe, expect, it } from 'vitest';
import {
  channelsFromSportsbiteCatalog,
  channelsFromM3u,
  resolverForSportsbiteId,
} from '../src/channels/import.js';
import { matchoraChannelId, parseMatchoraEmbedPp } from '../src/resolvers/matchora.js';
import { deriveSportsbiteStreamUrl } from '../src/resolvers/sportsbite.js';
import type { Channel } from '../src/channels/types.js';

describe('sportsbite derivation (xm family)', () => {
  it('maps the xm- prefix to the embed page URL', () => {
    expect(deriveSportsbiteStreamUrl('xm-30581')).toBe('https://sportsbite.org/xm-embed/embed/30581');
  });

  it('still maps the classic prefixes', () => {
    expect(deriveSportsbiteStreamUrl('247-beinsportsus')).toBe('https://sportsbite.org/247/beinsportsus');
    expect(deriveSportsbiteStreamUrl('t247-abc')).toBe('https://sportsbite.org/t247/abc');
    expect(deriveSportsbiteStreamUrl('cv-ae-usa')).toBe('https://sportsbite.org/cv/ae-usa');
  });
});

describe('resolverForSportsbiteId', () => {
  it('routes xm-<digits> channels to the matchora resolver', () => {
    expect(resolverForSportsbiteId('xm-30581')).toBe('matchora');
    expect(resolverForSportsbiteId('xm-646973')).toBe('matchora');
  });

  it('routes 247-/t247-/cv- channels to the sportsbite resolver', () => {
    expect(resolverForSportsbiteId('247-bbcone')).toBe('sportsbite');
    expect(resolverForSportsbiteId('t247-bbcone')).toBe('sportsbite');
    expect(resolverForSportsbiteId('cv-foo')).toBe('sportsbite');
  });
});

describe('matchoraChannelId', () => {
  const mk = (over: Partial<Channel>): Channel => ({
    id: 'xm-30581',
    name: 'BBC 1',
    resolver: 'custom',
    options: { custom: 'matchora' },
    ...over,
  });

  it('prefers options.sourceId', () => {
    expect(matchoraChannelId(mk({ options: { sourceId: 'xm-777' } }))).toBe('777');
  });

  it('falls back to tvgId then id', () => {
    expect(matchoraChannelId(mk({ tvgId: 'xm-42' }))).toBe('42');
    expect(matchoraChannelId(mk({}))).toBe('30581');
  });

  it('rejects non-xm channels', () => {
    expect(() => matchoraChannelId(mk({ id: '247-bbcone' }))).toThrow(/not a matchora/);
  });
});

describe('parseMatchoraEmbedPp', () => {
  it('extracts a real pass token', () => {
    const html = '<script>var PP="e5983227.0Q3m8JMJeQuNrHOhTQfGMo";</script>';
    expect(parseMatchoraEmbedPp(html)).toBe('e5983227.0Q3m8JMJeQuNrHOhTQfGMo');
  });

  it('skips placeholder tokens (leading underscore)', () => {
    const html = '<script>var PP="_disabled";var PP="e5983228.RLbuWLchb61SAt_NPqKamc";</script>';
    expect(parseMatchoraEmbedPp(html)).toBe('e5983228.RLbuWLchb61SAt_NPqKamc');
  });

  it('throws a retryable error when the token is missing', () => {
    expect(() => parseMatchoraEmbedPp('<html>no token here</html>')).toThrow(/pass token/);
  });
});

describe('channelsFromSportsbiteCatalog (xm entries)', () => {
  const catalog = JSON.stringify({
    total: 2,
    channels: [
      {
        id: 'xm-30581',
        short_id: '30581',
        name: 'BBC 1',
        category: 'Entertainment',
        status: 'online',
        format: 'iframe',
        content_type: 'text/html',
        manifest_url: 'https://sportsbite.org/xm-embed/embed/30581',
        browser_playable: true,
      },
      {
        id: 'xm-bad',
        name: 'Malformed xm id',
        status: 'online',
        browser_playable: true,
      },
    ],
  });

  it('imports xm-<digits> channels to the matchora resolver and drops malformed ids', () => {
    const out = channelsFromSportsbiteCatalog(catalog);
    expect(out.map((c) => c.id)).toEqual(['xm-30581']);
    const bbc = out[0];
    expect(bbc.options?.['custom']).toBe('matchora');
    expect(bbc.options?.['sourceId']).toBe('xm-30581');
    expect(bbc.tvgId).toBe('xm-30581');
  });
});

describe('channelsFromM3u (xm embed URLs)', () => {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="bbc1" tvg-logo="http://l/bbc.png" group-title="Entertainment",BBC 1',
    'https://sportsbite.org/xm-embed/embed/30581',
    '#EXTINF:-1 tvg-id="bbcone" group-title="General",BBC ONE',
    'https://sportsbite.org/247/bbcone',
  ].join('\n');

  it('maps xm-embed and 247 URLs to their resolvers', () => {
    const out = channelsFromM3u(m3u);
    const xm = out.find((c) => c.name === 'BBC 1');
    expect(xm?.options?.['custom']).toBe('matchora');
    expect(xm?.options?.['sourceId']).toBe('xm-30581');
    const onec = out.find((c) => c.name === 'BBC ONE');
    expect(onec?.options?.['custom']).toBe('sportsbite');
    expect(onec?.options?.['sourceId']).toBe('247-bbcone');
  });
});
