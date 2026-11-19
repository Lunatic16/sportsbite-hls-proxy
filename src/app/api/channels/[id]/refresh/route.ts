/** POST /api/channels/:id/refresh — force re-resolve (Direct URL refresh). */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkShareAuth } from '@/server/auth';
import { resolveChannel, invalidateResolution } from '@/server/resolvers';
import { publicHeaders } from '@/server/channels/types';
import { getLogger, shortUpstream } from '@/server/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const log = getLogger();
  const { id } = await ctx.params;
  const channel = store.get(id);
  if (!channel) return NextResponse.json({ error: `unknown channel "${id}"` }, { status: 404 });

  const access = checkShareAuth(req, channel.id);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

  invalidateResolution(channel.id);
  try {
    const resolved = await resolveChannel(channel);
    log.info({ channelId: channel.id, upstream: shortUpstream(resolved.url) }, 'channel re-resolved');
    return NextResponse.json({
      ok: true,
      direct: {
        url: resolved.url,
        expiresAt: resolved.expiresAt,
        headers: publicHeaders(resolved.headers),
      },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
