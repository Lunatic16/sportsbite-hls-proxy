/** GET /live/:channelId — share-friendly alias without the .m3u8 extension. */
import { NextRequest } from 'next/server';
import { serveChannelPlaylist } from '@/server/streamService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ channelId: string }> }) {
  const { channelId } = await ctx.params;
  return serveChannelPlaylist(req, channelId);
}
