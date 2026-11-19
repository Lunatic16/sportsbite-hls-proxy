/**
 * POST /api/import — import channels from a sportsbite catalog URL, M3U/M3U8
 * playlist (URL or host-local path), or channel JSON array. Body (JSON):
 *   { source: string, replace?: boolean, asM3uSource?: boolean }
 *
 * Dead upstream families (t247-/cv-) are skipped unless ALLOW_DEAD_SOURCES=true.
 */
import { NextRequest, NextResponse } from 'next/server';
import { checkGlobalAuth } from '@/server/auth';
import { importChannels } from '@/server/channels/import';
import { clearPlaylistCache } from '@/server/playlistService';
import { clearResolutionCache } from '@/server/resolvers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const access = checkGlobalAuth(req);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

  const body = (await req.json().catch(() => null)) as
    | { source?: string; replace?: boolean; asM3uSource?: boolean }
    | null;
  if (!body || typeof body.source !== 'string' || !body.source) {
    return NextResponse.json({ error: 'body must be { source: string, replace?, asM3uSource? }' }, { status: 400 });
  }

  try {
    const result = await importChannels(body.source, {
      replace: Boolean(body.replace),
      asM3uSource: Boolean(body.asM3uSource),
    });
    clearPlaylistCache();
    clearResolutionCache();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 400 });
  }
}
