/**
 * Line-based M3U8 parser + rewriter. Deliberately not a full AST parser:
 * tags are preserved verbatim; only URI-carrying attributes and bare URI
 * lines are transformed.
 */
import { buildProxyUrl, headersIdFor, type ProxyKind } from '../net/sign.js';
import type { UpstreamHeaders } from '../net/fetchUpstream.js';
import { resolveUri } from './resolve.js';

/**
 * Tags whose `URI="..."` attribute must be rewritten, and which proxy kind
 * the referenced resource is fetched through.
 */
const TAG_URI_KINDS: Record<string, ProxyKind> = {
  'EXT-X-KEY': 'key',
  'EXT-X-SESSION-KEY': 'key',
  'EXT-X-MAP': 'segment', // init segments are media data
  'EXT-X-MEDIA': 'playlist', // audio/subtitle renditions
  'EXT-X-PART': 'segment', // LL-HLS parts
  'EXT-X-PRELOAD-HINT': 'segment', // LL-HLS preload hints
  'EXT-X-I-FRAME-STREAM-INF': 'playlist',
  'EXT-X-RENDITION-REPORT': 'playlist', // LL-HLS rendition reports
  'EXT-X-SESSION-DATA': 'playlist',
};

const URI_ATTR_RE = /\bURI="([^"]*)"/;

export type UriTransform = (kind: ProxyKind, absoluteUrl: string) => string;

function defaultTransform(
  _baseUrl: string,
  headers: UpstreamHeaders | undefined,
  origin: string,
): UriTransform {
  const hid = headersIdFor(headers);
  return (kind, absoluteUrl) => buildProxyUrl(kind, origin, absoluteUrl, hid);
}

/**
 * Rewrite a playlist's URIs so every resource loops back through this proxy.
 *
 * - Non-#, non-empty lines are segment URIs (media playlists) or variant URIs
 *   (master playlists — detected via #EXT-X-STREAM-INF).
 * - Tags in TAG_URI_KINDS get their URI attribute rewritten.
 * - Relative URIs are resolved against `baseUrl` = the FINAL upstream URL
 *   (after redirects).
 * - Everything else is preserved byte-for-byte.
 */
export function rewritePlaylist(
  text: string,
  baseUrl: string,
  headers: UpstreamHeaders | undefined,
  origin: string,
  transform: UriTransform = defaultTransform(baseUrl, headers, origin),
): string {
  const isMaster = text.includes('#EXT-X-STREAM-INF');
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      out.push(line);
      continue;
    }
    if (trimmed.startsWith('#')) {
      out.push(rewriteTag(trimmed, baseUrl, transform));
      continue;
    }
    // Bare URI line.
    if (!/^https?:/i.test(trimmed) && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      const abs = resolveUri(trimmed, baseUrl);
      if (abs) {
        out.push(transform(isMaster ? 'playlist' : 'segment', abs));
        continue;
      }
    } else if (/^https?:/i.test(trimmed)) {
      out.push(transform(isMaster ? 'playlist' : 'segment', trimmed));
      continue;
    }
    // data: URIs or unresolvable lines pass through untouched.
    out.push(line);
  }
  return out.join('\n');
}

function rewriteTag(tag: string, baseUrl: string, transform: UriTransform): string {
  const tagName = tag.slice(1).split(/[:<]/, 1)[0].trim().toUpperCase();
  const kind = TAG_URI_KINDS[tagName];
  if (!kind) return tag;
  const m = tag.match(URI_ATTR_RE);
  if (!m) return tag;
  const uri = m[1];
  if (!uri || uri.startsWith('data:')) return tag;
  const abs = /^https?:/i.test(uri) ? uri : resolveUri(uri, baseUrl);
  if (!abs) return tag;
  return tag.replace(URI_ATTR_RE, `URI="${transform(kind, abs)}"`);
}

/** Does this playlist look like a master (variant) playlist? */
export function isMasterPlaylist(text: string): boolean {
  return text.includes('#EXT-X-STREAM-INF');
}

/** Is this a VOD (fully seekable) playlist? */
export function isVodPlaylist(text: string): boolean {
  return text.includes('#EXT-X-ENDLIST');
}
