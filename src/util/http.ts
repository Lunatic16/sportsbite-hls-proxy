/** Request helpers: public base URL derivation + client-disconnect aborts. */
import type { FastifyRequest } from 'fastify';
import { loadConfig } from '../config.js';

/**
 * Base URL used in generated playlists / share links:
 * PUBLIC_BASE_URL > X-Forwarded-Proto/Host (when TRUST_PROXY) > Host header.
 * Never hardcodes localhost, so LAN clients get reachable addresses.
 */
export function publicBase(req: FastifyRequest): string {
  const cfg = loadConfig();
  if (cfg.publicBaseUrl) return cfg.publicBaseUrl;

  let proto: string = req.protocol;
  let host = req.headers.host;
  if (cfg.trustProxy) {
    const fwdProto = req.headers['x-forwarded-proto'];
    if (typeof fwdProto === 'string' && fwdProto) proto = fwdProto.split(',')[0].trim();
    const fwdHost = req.headers['x-forwarded-host'];
    if (typeof fwdHost === 'string' && fwdHost) host = fwdHost.split(',')[0].trim();
  }
  if (!host) host = `${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`;
  return `${proto}://${host}`;
}

/** AbortSignal wired to the client connection; fires when the viewer leaves. */
export function abortOnClientClose(req: FastifyRequest): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.raw.on('close', onClose);
  req.raw.on('error', onClose);
  return {
    signal: controller.signal,
    dispose: () => {
      req.raw.off('close', onClose);
      req.raw.off('error', onClose);
    },
  };
}
