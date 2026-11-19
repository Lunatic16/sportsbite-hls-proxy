/**
 * POST /api/channels/:id/rotate-token — rotate the channel's share secret.
 * Old links stop working; global token or the channel's own valid token.
 */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkGlobalAuth } from '@/server/auth';
import { shareTokens } from '@/server/sign';
import { getChannelSecret, rotateChannelSecret } from '@/server/shareStore';
import { publicBase } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isShareTokenForChannel(req: NextRequest, channelId: string): boolean {
  const token = req.nextUrl.searchParams.get('token') ?? req.headers.get('x-auth-token') ?? '';
  if (!token) return false;
  return shareTokens.verify(channelId, token, getChannelSecret(channelId));
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const channel = store.get(id);
  if (!channel) return NextResponse.json({ error: `unknown channel "${id}"` }, { status: 404 });

  const access: { ok: boolean; status?: number; reason?: string } = checkGlobalAuth(req);
  if (!access.ok && !isShareTokenForChannel(req, channel.id)) {
    return NextResponse.json({ error: access.reason }, { status: access.status });
  }

  rotateChannelSecret(channel.id);
  const secret = getChannelSecret(channel.id);
  const token = shareTokens.issue(channel.id, secret);
  const base = publicBase(req);
  return NextResponse.json({
    ok: true,
    live: `${base}/live/${encodeURIComponent(channel.id)}?token=${token}`,
    m3u8: `${base}/stream/${encodeURIComponent(channel.id)}.m3u8?token=${token}`,
  });
}
