/**
 * Dynamic M3U playlist generation + XMLTV EPG stub.
 * Pure functions — unit-testable without a Next.js runtime.
 *
 * Entries point at /stream/<id>.m3u8 on THIS server (never at upstream URLs,
 * which expire). Base URL derives from the Host header (or X-Forwarded-*
 * with TRUST_PROXY, or PUBLIC_BASE_URL), so LAN players receive reachable
 * addresses.
 */
import type { Channel } from './channels/types';

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

/** Build the XMLTV EPG stub (channel list only — no programme data yet). */
export function buildEpgXml(channels: Channel[]): string {
  // XML entity escaping via unicode escapes so entities survive verbatim.
  const esc = (s: string | undefined) =>
    (s ?? '')
      .replace(/&/g, '\u0026amp;')
      .replace(/</g, '\u0026lt;')
      .replace(/>/g, '\u0026gt;')
      .replace(/"/g, '\u0026quot;');
  const parts: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="iptv-stream-proxy">',
  ];
  for (const ch of channels) {
    parts.push(`  <channel id="${esc(ch.tvgId ?? ch.id)}">`);
    parts.push(`    <display-name>${esc(ch.name)}</display-name>`);
    if (ch.logo) parts.push(`    <icon src="${esc(ch.logo)}" />`);
    parts.push(`  </channel>`);
  }
  parts.push('</tv>');
  return parts.join('\n') + '\n';
}
