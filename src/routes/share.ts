/**
 * Share & export API:
 *   GET  /api/channels/:id/share          — live, m3u8, direct, vlc, mpv payloads
 *   POST /api/channels/:id/refresh        — force re-resolve (Direct URL refresh)
 *   POST /api/channels/:id/rotate-token   — rotate the channel's share secret
 *
 * The `direct` (raw upstream) value is only returned to authenticated users
 * (global AUTH_TOKEN or the channel's own valid share token) and is never
 * logged. Cookie/Authorization headers are redacted from everything the API
 * returns.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { store } from '../channels/store.js';
import { publicHeaders, type ResolvedStream } from '../channels/types.js';
import { checkShareAuth, checkGlobalAuth, type AuthResult } from '../auth.js';
import { resolveChannel, invalidateResolution } from '../resolvers/index.js';
import { shareTokens } from '../net/sign.js';
import { getChannelSecret, rotateChannelSecret } from '../net/shareStore.js';
import { buildVlcCommand, buildMpvCommand, type ShellOs } from '../util/shellEscape.js';
import { getLogger, shortUpstream } from '../util/logger.js';
import { publicBase } from '../util/http.js';

const OS_VARIANTS: ShellOs[] = ['posix', 'powershell', 'cmd'];

export interface DirectPayload {
  url: string;
  expiresAt?: number;
  headers: Record<string, string>;
}

export function buildSharePayload(
  channel: { id: string; name: string },
  base: string,
  resolved: ResolvedStream | undefined,
): Record<string, unknown> {
  const secret = getChannelSecret(channel.id);
  const token = shareTokens.issue(channel.id, secret);
  const live = `${base}/live/${encodeURIComponent(channel.id)}?token=${token}`;
  const m3u8 = `${base}/stream/${encodeURIComponent(channel.id)}.m3u8?token=${token}`;
  const playlist = `${base}/playlist.m3u8`;

  const direct: DirectPayload | undefined = resolved
    ? { url: resolved.url, expiresAt: resolved.expiresAt, headers: publicHeaders(resolved.headers) }
    : undefined;

  const vlc: Record<string, string> = {};
  const mpv: Record<string, string> = {};
  for (const os of OS_VARIANTS) {
    vlc[`live${osSuffix(os)}`] = buildVlcCommand(live, undefined, os);
    mpv[`live${osSuffix(os)}`] = buildMpvCommand(live, undefined, os);
    if (direct) {
      vlc[`direct${osSuffix(os)}`] = buildVlcCommand(direct.url, direct.headers, os);
      mpv[`direct${osSuffix(os)}`] = buildMpvCommand(direct.url, direct.headers, os);
    }
  }

  return {
    channel: channel.id,
    name: channel.name,
    live,
    m3u8,
    playlist,
    direct,
    vlc,
    mpv,
  };
}

function osSuffix(os: ShellOs): string {
  return os === 'posix' ? '' : os === 'powershell' ? 'Win' : 'Cmd';
}

export function registerShareRoutes(app: FastifyInstance): void {
  const log = getLogger();

  app.get('/api/channels/:id/share', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const channel = store.get(id);
    if (!channel) return void reply.code(404).send({ error: `unknown channel "${id}"` });

    const access = checkShareAuth(req, channel.id);
    if (!access.ok) {
      return void reply
        .code(access.status)
        .send({ error: access.reason, direct: undefined });
    }

    let resolved: ResolvedStream | undefined;
    let resolveError: string | undefined;
    try {
      resolved = await resolveChannel(channel);
    } catch (err) {
      resolveError = (err as Error).message;
    }
    const payload = buildSharePayload({ id: channel.id, name: channel.name }, publicBase(req), resolved);
    if (resolveError) payload['resolveError'] = resolveError;
    return void reply.send(payload);
  });

  app.post('/api/channels/:id/refresh', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const channel = store.get(id);
    if (!channel) return void reply.code(404).send({ error: `unknown channel "${id}"` });

    const access = checkShareAuth(req, channel.id);
    if (!access.ok) return void reply.code(access.status).send({ error: access.reason });

    invalidateResolution(channel.id);
    try {
      const resolved = await resolveChannel(channel);
      log.info({ channelId: channel.id, upstream: shortUpstream(resolved.url) }, 'channel re-resolved');
      return void reply.send({
        ok: true,
        direct: {
          url: resolved.url,
          expiresAt: resolved.expiresAt,
          headers: publicHeaders(resolved.headers),
        },
      });
    } catch (err) {
      return void reply.code(502).send({ ok: false, error: (err as Error).message });
    }
  });

  app.post('/api/channels/:id/rotate-token', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const channel = store.get(id);
    if (!channel) return void reply.code(404).send({ error: `unknown channel "${id}"` });

    const access: AuthResult = checkGlobalAuth(req);
    if (!access.ok && !isShareTokenForChannel(req, channel.id)) {
      return void reply.code(access.status).send({ error: access.reason });
    }

    rotateChannelSecret(channel.id);
    const secret = getChannelSecret(channel.id);
    const token = shareTokens.issue(channel.id, secret);
    const base = publicBase(req);
    return void reply.send({
      ok: true,
      live: `${base}/live/${encodeURIComponent(channel.id)}?token=${token}`,
      m3u8: `${base}/stream/${encodeURIComponent(channel.id)}.m3u8?token=${token}`,
    });
  });
}

function isShareTokenForChannel(req: FastifyRequest, channelId: string): boolean {
  const q = (req.query ?? {}) as Record<string, string>;
  const headerToken = req.headers['x-auth-token'];
  const token = q['token'] ?? (typeof headerToken === 'string' ? headerToken : undefined);
  if (!token) return false;
  return shareTokens.verify(channelId, token, getChannelSecret(channelId));
}
