/**
 * POST /api/check — probe a batch of channels with bounded concurrency and
 * persist their statuses. Body (JSON, all optional):
 *   { ids?: string[], group?: string, search?: string, concurrency?: number }
 * Omit everything to check every channel.
 */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import type { Channel } from '@/server/channels/types';
import { checkGlobalAuth } from '@/server/auth';
import { checkChannels } from '@/server/probe';
import { loadConfig } from '@/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const access = checkGlobalAuth(req);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

  store.ensureLoaded();
  const body = (await req.json().catch(() => ({}))) as {
    ids?: string[];
    group?: string;
    search?: string;
    concurrency?: number;
  };

  let channels: Channel[] = store.list();
  if (body.ids?.length) {
    const wanted = new Set(body.ids.map((i) => i.toLowerCase()));
    channels = channels.filter((c) => wanted.has(c.id.toLowerCase()));
  }
  if (body.group) {
    const g = body.group.toLowerCase();
    channels = channels.filter((c) => (c.group ?? '').toLowerCase() === g);
  }
  if (body.search) {
    const s = body.search.toLowerCase();
    channels = channels.filter((c) => `${c.name} ${c.id} ${c.tvgId ?? ''}`.toLowerCase().includes(s));
  }

  const cfg = loadConfig();
  const concurrency = Math.max(1, Math.min(16, body.concurrency ?? cfg.checkConcurrency));
  const results = await checkChannels(channels, concurrency);

  return NextResponse.json({
    ok: true,
    checked: results.length,
    online: results.filter((r) => r.ok).length,
    results,
  });
}
