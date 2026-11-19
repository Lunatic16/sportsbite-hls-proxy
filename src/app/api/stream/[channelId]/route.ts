/** GET /api/stream/:channelId(.m3u8) — canonical rewritten playlist route. */
import { NextRequest } from 'next/server';
import { serveChannelPlaylist } from '@/server/streamService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await ctx.params;
  return serveChannelPlaylist(req, channelId);
}
