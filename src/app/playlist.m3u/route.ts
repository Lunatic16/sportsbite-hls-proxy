/** GET /playlist[.m3u|.m3u8] — extended M3U for IPTV players. */
import { NextRequest } from 'next/server';
import { store } from '@/server/channels/store';
import { buildM3u, type M3uOptions } from '@/server/m3u';
import { checkGlobalAuth } from '@/server/auth';
import { publicBase } from '@/server/http';
import { jsonError } from '@/server/proxyVerify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const access = checkGlobalAuth(req);
  if (!access.ok) return jsonError(access.status, access.reason);

  const q = req.nextUrl.searchParams;
  const opts: M3uOptions = {
    group: q.get('group') ?? undefined,
    search: q.get('search') ?? undefined,
    format: (q.get('format') as 'm3u' | 'm3u8' | null) ?? 'm3u8',
    download: q.get('download') === '1' || q.get('download') === 'true',
  };
  const body = buildM3u(store.list(), publicBase(req), opts);
  const headers: Record<string, string> = {
    'content-type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };
  if (opts.download) headers['content-disposition'] = 'attachment; filename="playlist.m3u8"';
  return new Response(body, { status: 200, headers });
}
