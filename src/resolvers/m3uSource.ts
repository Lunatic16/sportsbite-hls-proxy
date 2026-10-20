/**
 * m3u-source resolver: looks the channel up by tvg-id / name inside a source
 * playlist (local file or URL). The source is re-read at resolve time (with a
 * short cache), so regenerated upstream playlists keep working.
 */
import fs from 'node:fs';
import { TtlLruCache } from '../util/cache.js';
import { ResolverError } from '../channels/types.js';
import type { Channel, ResolvedStream } from '../channels/types.js';
import { fetchUpstream, UpstreamError } from '../net/fetchUpstream.js';
import { readBodyWithCap } from '../net/fetchUpstream.js';
import { loadConfig } from '../config.js';
import type { Resolver } from './types.js';

interface SourceEntry {
  url: string;
  attrs: Record<string, string>;
  name: string;
}

const sourceCache = new TtlLruCache<SourceEntry[]>(64, 60_000);

export function parseM3uEntries(text: string): SourceEntry[] {
  const lines = text.split(/\r?\n/);
  const entries: SourceEntry[] = [];
  let pending: { attrs: Record<string, string>; name: string } | undefined;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#EXTINF:')) {
      const attrs: Record<string, string> = {};
      const attrRe = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
      let m: RegExpExecArray | null;
      const afterColon = t.slice(t.indexOf(':') + 1);
      let name = afterColon;
      const comma = afterColon.lastIndexOf(',');
      if (comma >= 0) {
        name = afterColon.slice(comma + 1).trim();
      }
      while ((m = attrRe.exec(afterColon))) attrs[m[1].toLowerCase()] = m[2];
      pending = { attrs, name };
    } else if (t && !t.startsWith('#')) {
      if (pending) {
        entries.push({ url: t, attrs: pending.attrs, name: pending.name });
        pending = undefined;
      } else {
        entries.push({ url: t, attrs: {}, name: '' });
      }
    }
  }
  return entries;
}

async function loadSource(channel: Channel): Promise<SourceEntry[]> {
  const source = channel.options?.['source'];
  if (typeof source !== 'string' || !source) {
    throw new ResolverError(`channel "${channel.id}" (m3u-source) is missing options.source`, false);
  }
  const cacheKey = source;
  const cached = sourceCache.get(cacheKey);
  if (cached) return cached;

  let text: string;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchUpstream(source, { timeoutMs: 10_000 });
    if (res.status !== 200) {
      throw new ResolverError(`m3u source ${source} returned ${res.status}`, true);
    }
    const cfg = loadConfig();
    text = (await readBodyWithCap(res.body, cfg.upstreamMaxBodyMb * 1024 * 1024)).toString('utf8');
  } else {
    try {
      text = fs.readFileSync(source, 'utf8');
    } catch (err) {
      throw new ResolverError(`cannot read m3u source "${source}": ${(err as Error).message}`, false);
    }
  }
  const entries = parseM3uEntries(text);
  sourceCache.set(cacheKey, entries);
  return entries;
}

export const m3uSourceResolver: Resolver = {
  name: 'm3u-source',

  async resolve(channel: Channel): Promise<ResolvedStream> {
    const entries = await loadSource(channel);
    const match = (channel.options?.['match'] ?? {}) as { tvgId?: string; name?: string };
    const wantedId = (match.tvgId ?? channel.tvgId ?? '').toLowerCase();
    const wantedName = (match.name ?? channel.name ?? '').toLowerCase();

    let hit = entries.find((e) => wantedId && (e.attrs['tvg-id'] ?? '').toLowerCase() === wantedId);
    if (!hit && wantedName) {
      hit = entries.find((e) => e.name.toLowerCase() === wantedName || (e.attrs['tvg-name'] ?? '').toLowerCase() === wantedName);
    }
    if (!hit) {
      throw new ResolverError(`channel "${channel.id}" not found in m3u source`, true);
    }

    const resolved: ResolvedStream = {
      url: hit.url,
      headers: { ...(channel.headers ?? {}) },
    };
    // If the entry URL carries a token query param, assume it can expire.
    const ttlSeconds = typeof channel.options?.['ttlSeconds'] === 'number'
      ? (channel.options['ttlSeconds'] as number)
      : 300;
    if (/[?&](token|sig|signature|expires?|auth)=/i.test(hit.url)) {
      resolved.expiresAt = Date.now() + ttlSeconds * 1000;
    }
    return resolved;
  },
};

export { UpstreamError };
