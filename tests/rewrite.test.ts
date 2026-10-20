import { describe, expect, it } from 'vitest';
import { rewritePlaylist, isMasterPlaylist, isVodPlaylist } from '../src/hls/parser.js';
import { decodeUrlForProxy, verifyProxyUrl } from '../src/net/sign.js';

const ORIGIN = 'http://proxy.local:3000';

function decodeProxyLine(line: string): { path: string; url: string; h: string; s: string } {
  const u = new URL(line);
  return {
    path: u.pathname,
    url: decodeUrlForProxy(u.searchParams.get('url') ?? ''),
    h: u.searchParams.get('h') ?? '',
    s: u.searchParams.get('s') ?? '',
  };
}

describe('master playlist rewriting', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio/en/playlist.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="CC",URI="subs/cc.m3u8"',
    '#EXT-X-STREAMINF-PLACEHOLDER:NOPE',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aud"',
    'variants/720p.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=640000,RESOLUTION=640x360',
    'https://other-cdn.example/variants/360p.m3u8',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=90000,URI="iframes/mini.m3u8"',
  ].join('\n');

  it('rewrites variant URIs as playlists', () => {
    const out = rewritePlaylist(master, 'http://cdn.example/master.m3u8', undefined, ORIGIN);
    const lines = out.split('\n');
    const variant = decodeProxyLine(lines[6]);
    expect(variant.path).toBe('/proxy/playlist');
    expect(variant.url).toBe('http://cdn.example/variants/720p.m3u8');
    expect(verifyProxyUrl('playlist', Buffer.from(variant.url).toString('base64url'), variant.h, variant.s)).toBe(true);
    // a different (tampered) URL fails the signature check
    expect(verifyProxyUrl('playlist', Buffer.from('http://evil/x.m3u8').toString('base64url'), variant.h, variant.s)).toBe(false);
  });

  it('rewrites EXT-X-MEDIA rendition URIs as playlists', () => {
    const out = rewritePlaylist(master, 'http://cdn.example/master.m3u8', undefined, ORIGIN);
    const lines = out.split('\n');
    expect(lines[2]).toMatch(/^#EXT-X-MEDIA:.*URI="http:\/\/proxy\.local:3000\/proxy\/playlist\?url=/);
    const media = lines[2].match(/URI="([^"]+)"/)![1];
    expect(decodeProxyLine(media).url).toBe('http://cdn.example/audio/en/playlist.m3u8');
  });

  it('rewrites I-FRAME-STREAM-INF URI attribute', () => {
    const out = rewritePlaylist(master, 'http://cdn.example/master.m3u8', undefined, ORIGIN);
    const line = out.split('\n').find((l) => l.startsWith('#EXT-X-I-FRAME-STREAM-INF'))!;
    const uri = line.match(/URI="([^"]+)"/)![1];
    expect(decodeProxyLine(uri).path).toBe('/proxy/playlist');
  });

  it('keeps absolute upstream variant URLs absolute (resolved against their own value)', () => {
    const out = rewritePlaylist(master, 'http://cdn.example/master.m3u8', undefined, ORIGIN);
    const line = decodeProxyLine(out.split('\n')[8]);
    expect(line.url).toBe('https://other-cdn.example/variants/360p.m3u8');
  });

  it('preserves unknown tags verbatim', () => {
    const out = rewritePlaylist(master, 'http://cdn.example/master.m3u8', undefined, ORIGIN);
    expect(out).toContain('#EXT-X-STREAMINF-PLACEHOLDER:NOPE');
    expect(out).toContain('#EXT-X-VERSION:6');
  });
});

describe('media playlist rewriting', () => {
  const media = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:8',
    '#EXT-X-MEDIA-SEQUENCE:616367',
    '#EXT-X-PROGRAM-DATE-TIME:2026-10-19T19:46:57.930Z',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/1234.bin",IV=0x9c7db8778570d05c3177c349fd9236aa',
    '#EXT-X-MAP:URI="init-video.mp4"',
    '#EXTINF:7.8,',
    '2026/10/19/19/46/57-07800.ts?token=abc',
    '#EXTINF:7.8,',
    'https://segments.example/58-07800.ts',
    '#EXT-X-PART:DURATION=0.5,URI="part-1.m4s"',
    '#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part-2.m4s"',
    '#EXT-X-MAP:URI="data:application/vnd.apple.mpegurl;base64,SGVsbG8="',
  ].join('\n');

  const base = 'http://origin.example/live/pl.m3u8';
  const out = rewritePlaylist(media, base, undefined, ORIGIN);

  it('resolves relative segment URIs against the (final) playlist URL as segments', () => {
    const lines = out.split('\n');
    const seg = decodeProxyLine(lines[7]);
    expect(seg.path).toBe('/proxy/segment');
    expect(seg.url).toBe('http://origin.example/live/2026/10/19/19/46/57-07800.ts?token=abc');
  });

  it('rewrites keys through /proxy/key', () => {
    const keyLine = out.split('\n').find((l) => l.startsWith('#EXT-X-KEY'))!;
    const uri = keyLine.match(/URI="([^"]+)"/)![1];
    const decoded = decodeProxyLine(uri);
    expect(decoded.path).toBe('/proxy/key');
    expect(decoded.url).toBe('http://origin.example/live/keys/1234.bin');
    expect(keyLine).toContain('IV=0x9c7db8778570d05c3177c349fd9236aa');
    expect(keyLine).toContain('METHOD=AES-128');
  });

  it('rewrites EXT-X-MAP init segments as segments', () => {
    const mapLine = out.split('\n').find((l) => l.startsWith('#EXT-X-MAP'))!;
    const uri = mapLine.match(/URI="([^"]+)"/)![1];
    expect(decodeProxyLine(uri).path).toBe('/proxy/segment');
    expect(decodeProxyLine(uri).url).toBe('http://origin.example/live/init-video.mp4');
  });

  it('rewrites LL-HLS parts and preload hints as segments', () => {
    const partLine = out.split('\n').find((l) => l.startsWith('#EXT-X-PART'))!;
    expect(decodeProxyLine(partLine.match(/URI="([^"]+)"/)![1]).path).toBe('/proxy/segment');
    const hintLine = out.split('\n').find((l) => l.startsWith('#EXT-X-PRELOAD-HINT'))!;
    expect(decodeProxyLine(hintLine.match(/URI="([^"]+)"/)![1]).url).toBe('http://origin.example/live/part-2.m4s');
  });

  it('leaves data: URIs untouched', () => {
    const mapLine = out.split('\n').filter((l) => l.startsWith('#EXT-X-MAP'))[1];
    expect(mapLine).toContain('URI="data:application/vnd.apple.mpegurl;base64,SGVsbG8="');
  });

  it('resolves relative URIs against the redirect target (final URL), not the original', () => {
    // The playlist was fetched from /origin-a/pl.m3u8 but ended (after a 302)
    // on another host — relative segments must resolve against the final URL.
    const finalBase = 'https://redirected.example/final/pl.m3u8';
    const out2 = rewritePlaylist('#EXTM3U\n#EXTINF:4,\nseg.ts\n', finalBase, undefined, ORIGIN);
    const seg = decodeProxyLine(out2.split('\n')[2]);
    expect(seg.url).toBe('https://redirected.example/final/seg.ts');
  });

  it('treats master vs media correctly for bare URI lines', () => {
    const mediaOnly = rewritePlaylist('#EXTM3U\n#EXTINF:4,\ns.ts\n', base, undefined, ORIGIN);
    expect(decodeProxyLine(mediaOnly.split('\n')[2]).path).toBe('/proxy/segment');
    const masterOnly = rewritePlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhi.m3u8\n',
      base,
      undefined,
      ORIGIN,
    );
    expect(decodeProxyLine(masterOnly.split('\n')[2]).path).toBe('/proxy/playlist');
  });
});

describe('classification helpers', () => {
  it('detects master playlists', () => {
    expect(isMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n')).toBe(true);
    expect(isMasterPlaylist('#EXTM3U\n#EXTINF:4,\ns.ts\n')).toBe(false);
  });

  it('detects VOD playlists', () => {
    expect(isVodPlaylist('#EXTM3U\n#EXT-X-ENDLIST\n')).toBe(true);
    expect(isVodPlaylist('#EXTM3U\n#EXTINF:4,\ns.ts\n')).toBe(false);
  });
});
