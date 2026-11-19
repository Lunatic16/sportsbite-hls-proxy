/** POST /api/reload — re-read channels.json and drop all caches. */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkGlobalAuth } from '@/server/auth';
import { clearPlaylistCache } from '@/server/playlistService';
import { clearResolutionCache } from '@/server/resolvers';
import { clearSegmentCache } from '@/server/segmentService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const access = checkGlobalAuth(req);
    if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

    store.load();
    clearPlaylistCache();
    clearResolutionCache();
    clearSegmentCache();
    return NextResponse.json({ ok: true, channels: store.list().length });
  } catch (err) {
    console.error('[api/reload]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    );
  }
}
