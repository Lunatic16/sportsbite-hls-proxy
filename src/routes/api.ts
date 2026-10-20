/**
 * JSON API + health + static web UI (tiny hand-rolled static server — no
 * extra plugin dependencies).
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { store } from '../channels/store.js';
import { checkGlobalAuth } from '../auth.js';
import { publicBase } from '../util/http.js';
import { mimeForStatic } from '../hls/mime.js';
import { getLogger } from '../util/logger.js';
import { clearPlaylistCache } from '../hls/playlistService.js';
import { clearResolutionCache, invalidateResolution } from '../resolvers/index.js';

const PKG_VERSION = '1.0.0';

export function registerApiRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/health', async (_req, reply) => {
    let channelCount = 0;
    try {
      store.ensureLoaded();
      channelCount = store.list().length;
    } catch {
      /* report 0 rather than failing the healthcheck */
    }
    return void reply.send({
      ok: true,
      version: PKG_VERSION,
      uptimeSec: Math.round(process.uptime()),
      channels: channelCount,
    });
  });

  app.get('/api/channels', async (req, reply) => {
    const access = checkGlobalAuth(req);
    if (!access.ok) return void reply.code(access.status).send({ error: access.reason });
    store.ensureLoaded();
    const q = (req.query ?? {}) as Record<string, string>;
    const channels = store.list().map((c) => ({
      id: c.id,
      name: c.name,
      group: c.group ?? 'General',
      logo: c.logo,
      tvgId: c.tvgId,
      resolver: c.resolver,
      status: c.status ?? 'unknown',
    }));
    // optional server-side filtering mirrors the M3U filters
    let out = channels;
    if (q['group']) {
      const g = q['group'].toLowerCase();
      out = out.filter((c) => (c.group ?? '').toLowerCase().includes(g));
    }
    if (q['search']) {
      const s = q['search'].toLowerCase();
      out = out.filter((c) => `${c.name} ${c.id} ${c.tvgId ?? ''}`.toLowerCase().includes(s));
    }
    return void reply.send({
      total: channels.length,
      count: out.length,
      base: publicBase(req),
      channels: out,
    });
  });

  app.get('/api/channels/:id', async (req, reply) => {
    const access = checkGlobalAuth(req);
    if (!access.ok) return void reply.code(access.status).send({ error: access.reason });
    const id = (req.params as { id: string }).id;
    const c = store.get(id);
    if (!c) return void reply.code(404).send({ error: `unknown channel "${id}"` });
    return void reply.send({
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
  });

  app.post('/api/reload', async (req, reply) => {
    const access = checkGlobalAuth(req);
    if (!access.ok) return void reply.code(access.status).send({ error: access.reason });
    store.load();
    clearPlaylistCache();
    clearResolutionCache();
    return void reply.send({ ok: true, channels: store.list().length });
  });

  app.post('/api/channels/:id/invalidate', async (req, reply) => {
    const access = checkGlobalAuth(req);
    if (!access.ok) return void reply.code(access.status).send({ error: access.reason });
    const id = (req.params as { id: string }).id;
    invalidateResolution(id);
    clearPlaylistCache();
    return void reply.send({ ok: true });
  });

  // ── static web UI ─────────────────────────────────────────────────────────
  // Works both compiled (dist/routes/api.js → dist/web) and under tsx
  // (src/routes/api.ts → prefer dist/web which build:web produces).
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../dist/web'),
    path.resolve(here, '../../web'),
    path.resolve(process.cwd(), 'dist/web'),
    path.resolve(process.cwd(), 'web'),
  ];
  const webRoot =
    candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? candidates[0];
  if (!fs.existsSync(path.join(webRoot, 'app.js'))) {
    log.warn({ webRoot }, 'web UI not fully built — run npm run build:web');
  }

  app.get('/', async (_req, reply) => {
    return serveStatic(reply, webRoot, 'index.html');
  });

  app.get('/app.js', async (_req, reply) => serveStatic(reply, webRoot, 'app.js'));
  app.get('/style.css', async (_req, reply) => serveStatic(reply, webRoot, 'style.css'));
  app.get('/favicon.svg', async (_req, reply) => serveStatic(reply, webRoot, 'favicon.svg'));
}

async function serveStatic(reply: FastifyReply, root: string, name: string): Promise<void> {
  const file = path.join(root, name);
  if (!path.resolve(file).startsWith(path.resolve(root) + path.sep)) {
    void reply.code(403).send({ error: 'forbidden' });
    return;
  }
  try {
    const data = await fs.promises.readFile(file);
    const cacheable = name !== 'index.html';
    void reply
      .code(200)
      .header('content-type', mimeForStatic(name))
      .header('cache-control', cacheable ? 'public, max-age=300' : 'no-cache');
    void reply.send(data);
  } catch {
    void reply
      .code(404)
      .header('content-type', 'text/plain; charset=utf-8')
      .send('web UI not built — run: npm run build:web');
  }
}
