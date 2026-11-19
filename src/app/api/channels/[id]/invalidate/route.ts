/** POST /api/channels/:id/invalidate — drop the channel's cached resolution. */
import { NextRequest, NextResponse } from 'next/server';
import { checkGlobalAuth } from '@/server/auth';
import { invalidateResolution } from '@/server/resolvers';
import { clearPlaylistCache } from '@/server/playlistService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = checkGlobalAuth(req);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

  const { id } = await ctx.params;
  invalidateResolution(id);
  clearPlaylistCache();
  return NextResponse.json({ ok: true });
}
