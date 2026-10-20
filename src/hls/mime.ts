/** MIME types for proxy responses (compat: VLC, IPTVnator, Tivimate, Kodi, hls.js). */

const EXT_MIME: Record<string, string> = {
  '.ts': 'video/mp2t',
  '.m2t': 'video/mp2t',
  '.mts': 'video/mp2t',
  '.m4s': 'video/mp4',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.vtt': 'text/vtt',
  '.key': 'application/octet-stream',
  '.m3u8': 'application/vnd.apple.mpegurl',
};

export function mimeForPlaylist(): string {
  return 'application/vnd.apple.mpegurl';
}

export function mimeForKey(): string {
  return 'application/octet-stream';
}

export function mimeForSegment(url: string, upstreamContentType?: string): string {
  const clean = (upstreamContentType ?? '').split(';')[0].trim().toLowerCase();
  // Never pass upstream HTML/JSON through as a segment.
  if (clean && clean !== 'text/html' && clean !== 'application/json') {
    if (clean.startsWith('video/') || clean.startsWith('audio/') || clean === 'text/vtt' || clean === 'application/octet-stream') {
      return clean;
    }
  }
  try {
    const path = new URL(url).pathname.toLowerCase();
    const dot = path.lastIndexOf('.');
    if (dot >= 0) {
      const mime = EXT_MIME[path.slice(dot)];
      if (mime) return mime;
    }
  } catch {
    /* fall through */
  }
  return 'video/mp2t';
}

/** Static web asset MIME map (tiny hand-rolled static server). */
export function mimeForStatic(pathname: string): string {
  const dot = pathname.lastIndexOf('.');
  const ext = dot >= 0 ? pathname.slice(dot).toLowerCase() : '';
  const map: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
  };
  return map[ext] ?? 'application/octet-stream';
}
