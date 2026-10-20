/**
 * Import: convert a source playlist into the internal channels.json.
 *
 * Supported inputs (auto-detected by content):
 *  - Sportsbite catalog JSON (https://sportsbite.org/channels with Accept: any)
 *    → one `custom: sportsbite` resolver channel per catalog entry
 *  - M3U / M3U8 playlists (file path or http(s) URL)
 *    → static channels by default; --as-m3u-source keeps the file and creates
 *      m3u-source channels that re-lookup their URL at play time
 *  - Generic JSON array of channel objects
 *
 * Existing channels are matched by id and updated; --replace wipes first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.js';
import { store, slugify } from './store.js';
import type { Channel } from './types.js';
import { deriveSportsbiteStreamUrl } from '../resolvers/sportsbite.js';
import { parseM3uEntries } from '../resolvers/m3uSource.js';
import { getLogger } from '../util/logger.js';

interface SportsbiteCatalogChannel {
  id?: string;
  name?: string;
  category?: string;
  country?: string;
  status?: string;
  logo_url?: string;
  image?: string;
  source?: string;
  browser_playable?: boolean;
  manifest_url?: string;
}

interface ImportOptions {
  replace?: boolean;
  asM3uSource?: boolean;
  defaultGroup?: string;
}

/** Sanitize a channel name/attr: strip control chars + quotes. */
export function sanitizeText(value: string | undefined, fallback = ''): string {
  if (!value) return fallback;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/["\\]/g, '').trim();
  return cleaned || fallback;
}

export function channelsFromSportsbiteCatalog(raw: string): Channel[] {
  const parsed = JSON.parse(raw) as { channels?: SportsbiteCatalogChannel[] } | SportsbiteCatalogChannel[];
  const list = Array.isArray(parsed) ? parsed : (parsed.channels ?? []);
  const out: Channel[] = [];
  for (const entry of list) {
    if (!entry.id || !entry.name) continue;
    if (entry.status && entry.status !== 'online') continue;
    if (entry.browser_playable === false) continue;
    const id = slugify(entry.id);
    try {
      // Unknown prefixes would only fail at play time — verify at import.
      deriveSportsbiteStreamUrl(entry.id);
    } catch {
      continue;
    }
    out.push({
      id,
      name: sanitizeText(entry.name, id),
      group: sanitizeText(entry.category, 'General'),
      logo: entry.logo_url ?? entry.image,
      tvgId: entry.id,
      resolver: 'custom',
      options: { custom: 'sportsbite', sourceId: entry.id },
      status: entry.status === 'online' ? 'unknown' : 'offline',
    });
  }
  return out;
}

export function channelsFromM3u(
  raw: string,
  opts: ImportOptions & { sourcePath?: string } = {},
): Channel[] {
  const entries = parseM3uEntries(raw);
  const out: Channel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const name = sanitizeText(entry.name || entry.attrs['tvg-name'], '');
    if (!name) continue;
    let id = slugify(entry.attrs['tvg-id'] || name);
    while (seen.has(id)) id = id + '-' + (seen.size + 1);
    seen.add(id);

    const url = entry.url;
    const isSportsbite = /^https?:\/\/[^/]*sportsbite\.org\/(247|t247|cv)\//i.test(url);
    if (isSportsbite) {
      const m = url.match(/\/(247|t247|cv)\/([^/?#]+)/i);
      const catId = m ? `${m[1] === 't247' ? 't247' : m[1] === 'cv' ? 'cv' : '247'}-${m[2]}` : '';
      out.push({
        id,
        name,
        group: sanitizeText(entry.attrs['group-title'], opts.defaultGroup ?? 'General'),
        logo: entry.attrs['tvg-logo'] || undefined,
        tvgId: entry.attrs['tvg-id'] || id,
        resolver: 'custom',
        options: { custom: 'sportsbite', ...(catId ? { sourceId: catId } : {}) },
      });
      continue;
    }

    if (opts.asM3uSource && opts.sourcePath) {
      out.push({
        id,
        name,
        group: sanitizeText(entry.attrs['group-title'], opts.defaultGroup ?? 'General'),
        logo: entry.attrs['tvg-logo'] || undefined,
        tvgId: entry.attrs['tvg-id'] || id,
        resolver: 'm3u-source',
        options: {
          source: opts.sourcePath,
          match: { tvgId: entry.attrs['tvg-id'] || id, name },
        },
      });
      continue;
    }

    const tokenized = /[?&](token|sig|signature|expires?|auth)=/i.test(url);
    out.push({
      id,
      name,
      group: sanitizeText(entry.attrs['group-title'], opts.defaultGroup ?? 'General'),
      logo: entry.attrs['tvg-logo'] || undefined,
      tvgId: entry.attrs['tvg-id'] || id,
      resolver: 'static',
      url,
      headers: undefined,
      options: tokenized ? { ttlSeconds: 300 } : undefined,
    });
  }
  return out;
}

function looksLikeSportsbiteCatalog(raw: string): boolean {
  return raw.includes('"browser_playable"') || raw.includes('"channels"');
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0' },
  });
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  return res.text();
}

export async function importChannels(input: string, opts: ImportOptions = {}): Promise<{
  added: number;
  updated: number;
  total: number;
  kind: string;
}> {
  loadConfig();
  const log = getLogger();
  store.ensureLoaded();

  let raw: string;
  let sourcePath: string | undefined;
  if (/^https?:\/\//i.test(input)) {
    raw = await fetchText(input);
  } else {
    raw = fs.readFileSync(input, 'utf8');
    sourcePath = input;
  }

  let channels: Channel[];
  let kind: string;
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    if (looksLikeSportsbiteCatalog(raw)) {
      channels = channelsFromSportsbiteCatalog(raw);
      kind = 'sportsbite-catalog';
    } else {
      const arr = JSON.parse(raw) as Channel[];
      channels = arr
        .filter((c) => c.id && c.name && c.resolver)
        .map((c) => ({ ...c, name: sanitizeText(c.name, c.id) }));
      kind = 'json';
    }
  } else if (trimmed.startsWith('#EXTM3U') || trimmed.includes('#EXTINF')) {
    if (opts.asM3uSource && sourcePath) {
      // Keep the source file next to channels.json so it survives restarts.
      const dataDir = loadConfig().dataDir;
      const dest = sourcePath === input ? path.join(dataDir, 'source.m3u') : undefined;
      if (dest && path.resolve(sourcePath) !== path.resolve(dest)) {
        fs.copyFileSync(sourcePath, dest);
        sourcePath = dest;
      }
    }
    channels = channelsFromM3u(raw, { ...opts, sourcePath });
    kind = 'm3u';
  } else {
    throw new Error('unrecognized input format (expected M3U, sportsbite catalog JSON, or channel JSON array)');
  }

  if (channels.length === 0) throw new Error('no usable channels found in input');
  const result = store.upsertMany(channels, opts.replace);
  log.info({ kind, ...result }, 'import complete');
  return { ...result, kind };
}

