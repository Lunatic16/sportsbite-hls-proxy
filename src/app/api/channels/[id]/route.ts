/** GET /api/channels/:id — single channel detail with entry-point URLs. */
import { NextRequest, NextResponse } from 'next/server';
import { store } from '@/server/channels/store';
import { checkGlobalAuth } from '@/server/auth';
import { publicBase } from '@/server/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const access = checkGlobalAuth(req);
  if (!access.ok) return NextResponse.json({ error: access.reason }, { status: access.status });

  const { id } = await ctx.params;
  const c = store.get(id);
  if (!c) return NextResponse.json({ error: `unknown channel "${id}"` }, { status: 404 });

  return NextResponse.json({
    id: c.id,
    name: c.name,
    group: c.group ?? 'General',
    logo: c.logo,
    tvgId: c.tvgId,
    resolver: c.resolver,
    status: c.status ?? 'unknown',
    lastChecked: c.lastChecked,
    stream: `${publicBase(req)}/stream/${encodeURIComponent(c.id)}.m3u8`,
    live: `${publicBase(req)}/live/${encodeURIComponent(c.id)}`,
  });
}
