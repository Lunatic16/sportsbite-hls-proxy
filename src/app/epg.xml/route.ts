/** GET /epg.xml — XMLTV channel stub. */
import { NextRequest } from 'next/server';
import { store } from '@/server/channels/store';
import { buildEpgXml } from '@/server/m3u';
import { checkGlobalAuth } from '@/server/auth';
import { jsonError } from '@/server/proxyVerify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest): Promise<Response> {
  const access = checkGlobalAuth(req);
  if (!access.ok) return jsonError(access.status, access.reason);

  return new Response(buildEpgXml(store.list()), {
    status: 200,
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600',
    },
  });
}
