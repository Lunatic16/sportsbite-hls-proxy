/**
 * GET /api/channels/:id/share — live, m3u8, direct, vlc, mpv payloads.
 * The `direct` (raw upstream) value is only returned to authenticated users
 * (global AUTH_TOKEN or the channel's own valid share token) and is never
 * logged.
 */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkShareAuth } from '@/server/auth';
import { resolveChannel } from '@/server/resolvers';
import { buildSharePayload } from '@/server/share';
import { getLogger, shortUpstream } from '@/server/logger';
import { publicBase } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const log = getLogger();
  const { id } = await ctx.params;
  const channel = store.get(id);
  if (!channel) return NextResponse.json({ error: `unknown channel "${id}"` }, { status: 404 });

  const access = checkShareAuth(req, channel.id);
  if (!access.ok) {
    return NextResponse.json({ error: access.reason, direct: undefined }, { status: access.status });
  }

  let resolved;
  let resolveError: string | undefined;
  try {
    resolved = await resolveChannel(channel);
  } catch (err) {
    resolveError = (err as Error).message;
  }
  const payload = buildSharePayload({ id: channel.id, name: channel.name }, publicBase(req), resolved);
  if (resolveError) {
    payload['resolveError'] = resolveError;
    log.info({ channelId: channel.id, err: resolveError, upstream: resolved ? shortUpstream(resolved.url) : '' }, 'share resolve failed');
  }
  return NextResponse.json(payload);
}
