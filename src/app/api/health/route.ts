import { NextResponse } from 'next/server';
import { store } from '@/server/channels/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PKG_VERSION = '2.0.0';

export async function GET() {
  let channelCount = 0;
  let channelsError: string | null = null;
  try {
    store.ensureLoaded();
    channelCount = store.list().length;
  } catch (err) {
    /* report 0 rather than failing the healthcheck, but keep the reason —
       `curl /api/health` is the fastest way to see WHY the channel list is
       empty (permissions, corrupt channels.json, bad env var, ...) */
    channelsError = err instanceof Error ? err.message : 'unknown error';
  }
  const body: Record<string, unknown> = {
    ok: true,
    version: PKG_VERSION,
    uptimeSec: Math.round(process.uptime()),
    channels: channelCount,
  };
  if (channelsError) body.channelsError = channelsError;
  return NextResponse.json(body);
}
