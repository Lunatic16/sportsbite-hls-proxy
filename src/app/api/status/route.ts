/**
 * GET /api/status — server status card (uptime, versions, cache + memory).
 */
import { NextRequest, NextResponse } from 'next/server';
import { loadConfig } from '@/server/config';
import { store } from '@/server/channels/store';
import { checkGlobalAuth } from '@/server/auth';
import { playlistCacheStats } from '@/server/playlistService';
import { segmentCacheStats } from '@/server/segmentService';
import { resolutionCacheStats } from '@/server/resolvers';
import { headerRegistrySize } from '@/server/headerRegistry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PKG_VERSION = '2.0.0';

export async function GET(req: NextRequest) {
  try {
    const access = checkGlobalAuth(req);
    if (!access.ok) {
      return NextResponse.json({ error: access.reason }, { status: access.status });
    }

    let channelCount = 0;
    try {
      store.ensureLoaded();
      channelCount = store.list().length;
    } catch {
      /* keep going — status endpoint must not throw */
    }

    const mem = process.memoryUsage();
    const cfg = loadConfig();

    return NextResponse.json({
      version: PKG_VERSION,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      channels: channelCount,
      online: store.list().filter((c) => c.status === 'online').length,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
      cache: {
        playlists: playlistCacheStats(),
        segments: segmentCacheStats(),
        resolutions: resolutionCacheStats(),
        headers: headerRegistrySize(),
      },
      config: {
        authRequired: Boolean(cfg.authToken),
        shareTokenRequired: cfg.shareTokenRequired,
        allowPrivateUpstreams: cfg.allowPrivateUpstreams,
        segCacheMb: cfg.segCacheMaxMb,
        segCacheTtlMs: cfg.segCacheTtlMs,
      },
    });
  } catch (err) {
    console.error('[api/status]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'internal error' },
      { status: 500 },
    );
  }
}
