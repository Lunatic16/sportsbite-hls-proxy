/**
 * GET /api/channels — channel list for the web UI (optional group/search
 * server-side filters).
 */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkGlobalAuth } from '@/server/auth';
import { publicBase } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const access = checkGlobalAuth(req);
    if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

    store.ensureLoaded();
    const q = req.nextUrl.searchParams;
    const channels = store.list().map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group ?? 'General',
      logo: c.logo,
      tvgId: c.tvgId,
      resolver: c.resolver,
      status: c.status ?? 'unknown',
      lastChecked: c.lastChecked,
    }));
    let out = channels;
    const group = q.get('group');
    if (group) {
      const g = group.toLowerCase();
      out = out.filter((c) => (c.group ?? '').toLowerCase().includes(g));
    }
    const search = q.get('search');
    if (search) {
      const s = search.toLowerCase();
      out = out.filter((c) => `${c.name} ${c.id} ${c.tvgId ?? ''}`.toLowerCase().includes(s));
    }
    return NextResponse.json({
      total: channels.length,
      count: out.length,
      base: publicBase(req),
      channels: out,
    });
  } catch (err) {
    // Store/config failures (bad channels.json, unwritable data dir, invalid
    // env) must reach the UI as { error } JSON — a bare Next.js 500 renders as
    // the useless literal "HTTP 500" in the channel list.
    console.error('[api/channels]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    );
  }
}
