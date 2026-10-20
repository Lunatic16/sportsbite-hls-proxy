/**
 * Dynamic M3U8 playlist generation:
 *   GET /playlist.m3u8 | /playlist.m3u | /playlist  — extended M3U
 *   GET /epg.xml                                    — XMLTV stub
 *
 * Entries point at /stream/<id>.m3u8 on THIS server (never at upstream URLs,
 * which expire). Base URL derives from the Host header (or X-Forwarded-*
 * with TRUST_PROXY, or PUBLIC_BASE_URL), so LAN players receive reachable
 * addresses.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { store } from '../channels/store.js';
import type { Channel } from '../channels/types.js';
import { publicBase } from '../util/http.js';
import { checkGlobalAuth } from '../auth.js';

export interface M3uOptions {
  group?: string;
  search?: string;
  format?: 'm3u' | 'm3u8';
  download?: boolean;
}

/** Escape an M3U attribute value: quotes, newlines and control chars. */
export function escapeM3uAttr(value: string | undefined): string {
  if (!value) return '';
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/"/g, "'")
    .replace(/\\/g, '/');
}

export function filterChannels(channels: Channel[], opts: M3uOptions): Channel[] {
  let out = channels;
  if (opts.group) {
    const g = opts.group.toLowerCase();
    const exact = out.filter((c) => (c.group ?? '').toLowerCase() === g);
    if (exact.length > 0) out = exact;
    else out = out.filter((c) => (c.group ?? '').toLowerCase().includes(g));
  }
  if (opts.search) {
    const s = opts.search.toLowerCase();
    out = out.filter((c) => {
      const hay = `${c.name} ${c.id} ${c.tvgId ?? ''} ${c.group ?? ''}`.toLowerCase();
      return hay.includes(s);
    });
  }
  return out;
}

/** Build the extended M3U text (pure function — unit tested). */
export function buildM3u(channels: Channel[], baseUrl: string, opts: M3uOptions = {}): string {
  const lines: string[] = [`#EXTM3U x-tvg-url="${escapeM3uAttr(baseUrl)}/epg.xml"`];

  for (const ch of filterChannels(channels, opts)) {
    const attrs = [
      `tvg-id="${escapeM3uAttr(ch.tvgId ?? ch.id)}"`,
      `tvg-name="${escapeM3uAttr(ch.name)}"`,
      ch.logo ? `tvg-logo="${escapeM3uAttr(ch.logo)}"` : '',
      `group-title="${escapeM3uAttr(ch.group ?? 'General')}"`,
    ]
      .filter(Boolean)
      .join(' ');
    lines.push(`#EXTINF:-1 ${attrs},${escapeM3uAttr(ch.name)}`);
    lines.push(`${baseUrl}/stream/${encodeURIComponent(ch.id)}.m3u8`);
  }
  return lines.join('\n') + '\n';
}

function playlistHandler(format: 'm3u' | 'm3u8') {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const access = checkGlobalAuth(req);
    if (!access.ok) {
      return void reply.code(access.status).send({ error: access.reason });
    }
    const q = (req.query ?? {}) as Record<string, string>;
    const opts: M3uOptions = {
      group: q['group'],
      search: q['search'],
      format: (q['format'] as 'm3u' | 'm3u8' | undefined) ?? format,
      download: q['download'] === '1' || q['download'] === 'true',
    };
    const body = buildM3u(store.list(), publicBase(req), opts);
    void reply
      .code(200)
      .header('content-type', 'application/vnd.apple.mpegurl; charset=utf-8')
      .header('access-control-allow-origin', '*')
      .header('cache-control', 'no-store');
    if (opts.download) {
      void reply.header('content-disposition', 'attachment; filename="playlist.m3u8"');
    }
    return reply.send(body);
  };
}

export function registerPlaylistRoutes(app: FastifyInstance): void {
  app.get('/playlist.m3u8', playlistHandler('m3u8'));
  app.get('/playlist.m3u', playlistHandler('m3u'));
  app.get('/playlist', playlistHandler('m3u8'));

  app.get('/epg.xml', async (req: FastifyRequest, reply: FastifyReply) => {
    const access = checkGlobalAuth(req);
    if (!access.ok) return void reply.code(access.status).send({ error: access.reason });
    // XML entity escaping via unicode escapes so entities survive verbatim.
    const esc = (s: string | undefined) =>
      (s ?? '')
        .replace(/&/g, '\u0026amp;')
        .replace(/</g, '\u0026lt;')
        .replace(/>/g, '\u0026gt;')
        .replace(/"/g, '\u0026quot;');
    const channels = store.list();
    const parts: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv generator-info-name="sportsbite-hls-proxy">',
    ];
    for (const ch of channels) {
      parts.push(`  <channel id="${esc(ch.tvgId ?? ch.id)}">`);
      parts.push(`    <display-name>${esc(ch.name)}</display-name>`);
      if (ch.logo) parts.push(`    <icon src="${esc(ch.logo)}" />`);
      parts.push(`  </channel>`);
    }
    parts.push('</tv>');
    void reply
      .code(200)
      .header('content-type', 'application/xml; charset=utf-8')
      .header('cache-control', 'public, max-age=600');
    return reply.send(parts.join('\n') + '\n');
  });
}
