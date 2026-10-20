import { describe, expect, it } from 'vitest';
import {
  channelsFromSportsbiteCatalog,
  channelsFromM3u,
  sanitizeText,
} from '../src/channels/import.js';
import { slugify } from '../src/channels/store.js';
import { deriveSportsbiteStreamUrl } from '../src/resolvers/sportsbite.js';

describe('slugify', () => {
  it('slugs names and ids', () => {
    expect(slugify('beIN SPORTS USA!')).toBe('bein-sports-usa');
    expect(slugify('  ---  ')).toBe('channel');
    expect(slugify('Éé Çç')).toBe('ee-cc');
  });
});

describe('sportsbite derivation', () => {
  it('maps every documented prefix', () => {
    expect(deriveSportsbiteStreamUrl('247-beinsportsus')).toBe('https://sportsbite.org/247/beinsportsus');
    expect(deriveSportsbiteStreamUrl('t247-abc')).toBe('https://sportsbite.org/t247/abc');
    expect(deriveSportsbiteStreamUrl('cv-ae-usa')).toBe('https://sportsbite.org/cv/ae-usa');
  });

  it('rejects unknown prefixes', () => {
    expect(() => deriveSportsbiteStreamUrl('zzz-foo')).toThrow(/unknown sportsbite id prefix/);
    expect(() => deriveSportsbiteStreamUrl('247-')).toThrow();
  });
});

describe('channelsFromSportsbiteCatalog', () => {
  const catalog = JSON.stringify({
    total: 4,
    channels: [
      {
        id: '247-beinsportsus',
        name: 'beIN SPORTS USA',
        category: 'Sports',
        status: 'online',
        browser_playable: true,
        logo_url: 'http://l/bein.png',
      },
      { id: 't247-abc', name: 'ABC', category: 'Entertainment', status: 'online', browser_playable: true },
      { id: 'cv-ae-usa', name: 'AE USA (dead)', category: 'Sports', status: 'online', browser_playable: true },
      { id: '247-offline-ch', name: 'Offline', status: 'offline', browser_playable: true },
      { id: '247-notplayable', name: 'Not playable', status: 'online', browser_playable: false },
      { id: 'weird-unknown-prefix', name: 'Unknown', status: 'online', browser_playable: true },
    ],
  });

  it('imports online+playable channels with known prefixes only', () => {
    const out = channelsFromSportsbiteCatalog(catalog);
    expect(out.map((c) => c.id).sort()).toEqual(['247-beinsportsus', 'cv-ae-usa', 't247-abc']);
  });

  it('marks them as custom sportsbite resolver channels with group + logo + tvgId', () => {
    const out = channelsFromSportsbiteCatalog(catalog);
    const bein = out.find((c) => c.id === '247-beinsportsus')!;
    expect(bein.resolver).toBe('custom');
    expect(bein.options?.['custom']).toBe('sportsbite');
    expect(bein.options?.['sourceId']).toBe('247-beinsportsus');
    expect(bein.group).toBe('Sports');
    expect(bein.logo).toBe('http://l/bein.png');
    expect(bein.tvgId).toBe('247-beinsportsus');
  });
});

describe('channelsFromM3u', () => {
  const m3u = [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="247-beinsportsus" tvg-name="beIN SPORTS USA" group-title="Sports" tvg-logo="http://l/b.png",beIN SPORTS USA',
    'https://sportsbite.org/247/beinsportsus',
    '#EXTINF:-1 tvg-id="tok-1" tvg-name="Token Channel" group-title="News",Token Channel',
    'https://cdn.example/live/tok.m3u8?token=abc&expires=123',
    '#EXTINF:-1 tvg-id="plain-1" tvg-name="Plain",Plain Channel',
    'https://cdn.example/live/plain.m3u8',
  ].join('\n');

  it('detects sportsbite URLs and maps them to the sportsbite resolver', () => {
    const out = channelsFromM3u(m3u, {});
    const bein = out.find((c) => c.name === 'beIN SPORTS USA')!;
    expect(bein.resolver).toBe('custom');
    expect(bein.options?.['custom']).toBe('sportsbite');
    expect(bein.group).toBe('Sports');
  });

  it('creates static channels and flags tokenized URLs with a TTL', () => {
    const out = channelsFromM3u(m3u, {});
    const tok = out.find((c) => c.id === 'tok-1')!;
    expect(tok.resolver).toBe('static');
    expect(tok.url).toBe('https://cdn.example/live/tok.m3u8?token=abc&expires=123');
    expect(tok.options?.['ttlSeconds']).toBe(300);
    const plain = out.find((c) => c.id === 'plain-1')!;
    expect(plain.resolver).toBe('static');
    expect(plain.options?.['ttlSeconds']).toBeUndefined();
  });

  it('asM3uSource mode wires channels to the saved source file', () => {
    const out = channelsFromM3u(m3u, { asM3uSource: true, sourcePath: '/data/source.m3u' });
    const plain = out.find((c) => c.id === 'plain-1')!;
    expect(plain.resolver).toBe('m3u-source');
    expect(plain.options?.['source']).toBe('/data/source.m3u');
    expect((plain.options?.['match'] as Record<string, string>)['tvgId']).toBe('plain-1');
  });

  it('sanitizes names with quotes/newlines and dedupes ids', () => {
    const dirty = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="a" tvg-name="Bad"name",Bad"name',
      'http://x/1.m3u8',
      '#EXTINF:-1 tvg-id="a" tvg-name="Dup",Dup',
      'http://x/2.m3u8',
    ].join('\n');
    const out = channelsFromM3u(dirty, {});
    expect(out).toHaveLength(2);
    expect(out[0].id).toBe('a');
    expect(out[0].name).not.toContain('"');
    expect(out[1].id).not.toBe('a');
  });
});

describe('sanitizeText', () => {
  it('strips control characters, quotes and backslashes', () => {
    expect(sanitizeText('ok"fine\\path')).toBe('okfinepath');
    expect(sanitizeText('a\nb\tc')).toBe('a b c');
    expect(sanitizeText('', 'fallback')).toBe('fallback');
  });
});
