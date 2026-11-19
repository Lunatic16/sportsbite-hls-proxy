/**
 * POST /api/channels/:id/check — probe one channel (resolve → playlist →
 * first segment head) and persist its online/offline status. Used by the
 * UI's per-channel status dots and check buttons.
 */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkGlobalAuth } from '@/server/auth';
import { checkChannel } from '@/server/probe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = checkGlobalAuth(req);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

  const { id } = await ctx.params;
  const channel = store.get(id);
  if (!channel) return NextResponse.json({ error: `unknown channel "${id}"` }, { status: 404 });

  const result = await checkChannel(channel);
  return NextResponse.json({ ...result, status: result.ok ? 'online' : 'offline' });
}
