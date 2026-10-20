import { describe, expect, it } from 'vitest';
import { buildM3u, escapeM3uAttr, filterChannels } from '../src/routes/playlist.js';
import type { Channel } from '../src/channels/types.js';

const BASE = 'http://192.168.1.50:3000';

const channels: Channel[] = [
  { id: '247-beinsportsus', name: 'beIN SPORTS USA', group: 'Sports', logo: 'http://l/1.png', tvgId: '247-beinsportsus', resolver: 'custom' },
  { id: 't247-abc', name: 'ABC News', group: 'News', tvgId: 't247-abc', resolver: 'custom' },
  { id: 'apple-bipbop', name: 'Test "Quoted" Stream', resolver: 'static' },
];

describe('buildM3u', () => {
  it('generates an extended M3U pointing at this server', () => {
    const out = buildM3u(channels, BASE);
    expect(out.startsWith('#EXTM3U')).toBe(true);
    expect(out).toContain('#EXTINF:-1 tvg-id="247-beinsportsus" tvg-name="beIN SPORTS USA" tvg-logo="http://l/1.png" group-title="Sports",beIN SPORTS USA');
    expect(out).toContain(`${BASE}/stream/247-beinsportsus.m3u8`);
    expect(out).toContain(`${BASE}/stream/t247-abc.m3u8`);
    // default group fills in
    expect(out).toContain('group-title="General"');
  });

  it('escapes quotes, backslashes and control characters in attributes', () => {
    const nasty: Channel[] = [
      { id: 'nasty', name: 'Bad "name"\nwith newline\rtab\there', group: 'Grp"x', resolver: 'static' },
    ];
    const out = buildM3u(nasty, BASE);
    // attributes: quotes become ', newlines collapse to spaces
    expect(out).toContain(`tvg-name="Bad 'name' with newline tab here"`);
    expect(out).toContain(`group-title="Grp'x"`);
    // the display name is sanitized onto a single line — entry ends at the
    // first newline, then the stream URL follows
    expect(out).not.toContain('"name"');
    expect(out).toContain(`,Bad 'name' with newline tab here\n${BASE}/stream/nasty.m3u8`);
  });

  it('escapes the attr-escape helper directly', () => {
    expect(escapeM3uAttr('say "hi"')).toBe("say 'hi'");
    expect(escapeM3uAttr('line1\nline2')).toBe('line1 line2');
    expect(escapeM3uAttr('back\\slash')).toBe('back/slash');
    expect(escapeM3uAttr(undefined)).toBe('');
  });

  it('filterChannels: group (exact, then substring fallback) and search', () => {
    expect(filterChannels(channels, { group: 'Sports' }).map((c) => c.id)).toEqual([
      '247-beinsportsus',
    ]);
    expect(filterChannels(channels, { group: 'new' }).map((c) => c.id)).toEqual(['t247-abc']);
    expect(filterChannels(channels, { search: 'beIN' }).map((c) => c.id)).toEqual(['247-beinsportsus']);
    expect(filterChannels(channels, { search: 'quoted' }).map((c) => c.id)).toEqual(['apple-bipbop']);
    expect(filterChannels(channels, { search: 'T247-ABC' }).map((c) => c.id)).toEqual(['t247-abc']);
    expect(filterChannels(channels, {})).toHaveLength(3);
  });

  it('URL-encodes channel ids in stream URLs', () => {
    const out = buildM3u([{ id: 'weird id/x', name: 'Weird', resolver: 'static' }], BASE);
    expect(out).toContain(`${BASE}/stream/weird%20id%2Fx.m3u8`);
  });
});
