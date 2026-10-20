/**
 * Resolver registry + lazy resolution cache.
 *
 * - Resolving happens lazily on first request, never at startup.
 * - Resolved URLs are cached until expiresAt (or RESOLVE_TTL_MS default).
 * - Routes call resolveWithRetry(): on upstream 403/404/410 they force a
 *   re-resolve and retry the fetch once.
 */
import { loadConfig } from '../config.js';
import type { Channel, ResolvedStream } from '../channels/types.js';
import { ResolverError } from '../channels/types.js';
import { getLogger } from '../util/logger.js';
import { staticResolver } from './static.js';
import { m3uSourceResolver } from './m3uSource.js';
import { sportsbiteResolver } from './sportsbite.js';
import type { Resolver } from './types.js';

export const registry = new Map<string, Resolver>([
  ['static', staticResolver],
  ['m3u-source', m3uSourceResolver],
  ['sportsbite', sportsbiteResolver],
]);

/** Register your own resolver implementation at startup (see custom.example.ts). */
export function registerResolver(name: string, resolver: Resolver): void {
  registry.set(name, resolver);
}

interface CacheEntry {
  resolved: ResolvedStream;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

export function invalidateResolution(channelId: string): void {
  cache.delete(channelId.toLowerCase());
}

export function clearResolutionCache(): void {
  cache.clear();
}

export async function resolveChannel(channel: Channel): Promise<ResolvedStream> {
  const key = channel.id.toLowerCase();
  const cfg = loadConfig();

  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.resolved;
  }

  const resolverKind =
    channel.resolver === 'custom'
      ? String(channel.options?.['custom'] ?? '')
      : channel.resolver;
  const resolver = registry.get(resolverKind);
  if (!resolver) {
    throw new ResolverError(
      channel.resolver === 'custom'
        ? `custom resolver "${resolverKind}" is not registered (options.custom)`
        : `unknown resolver "${channel.resolver}"`,
      false,
    );
  }

  const resolved = await withTimeout(
    resolver.resolve(channel),
    cfg.resolveTimeoutMs,
    `resolver "${resolverKind}" timed out for "${channel.id}"`,
  );

  const ttl = resolved.expiresAt ?? Date.now() + cfg.resolveTtlMs;
  cache.set(key, { resolved, expiresAt: ttl });
  return resolved;
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ResolverError(message, true)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Unwraps the resolution layer so routes only see fetch results. */
export type UpstreamStatus = number;

/**
 * Resolve + fetch with the documented retry contract: if the upstream answers
 * 403/404/410 (usually an expired token), invalidate the cached URL, resolve
 * again and retry the fetch exactly once.
 */
export async function resolveAndFetch(
  channel: Channel,
  fetchFn: (resolved: ResolvedStream) => Promise<{ status: UpstreamStatus;[k: string]: unknown }>,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ resolved: ResolvedStream; result: { status: UpstreamStatus;[k: string]: unknown }; retried: boolean }> {
  let resolved = await resolveChannel(channel);
  let result = await fetchFn(resolved);
  let retried = false;

  if (opts.forceRefresh) {
    invalidateResolution(channel.id);
    resolved = await resolveChannel(channel);
    result = await fetchFn(resolved);
    retried = true;
  } else if ([403, 404, 410].includes(result.status)) {
    getLogger().debug(
      { channelId: channel.id, status: result.status },
      'upstream rejected resolved URL — re-resolving',
    );
    invalidateResolution(channel.id);
    resolved = await resolveChannel(channel);
    result = await fetchFn(resolved);
    retried = true;
  }

  return { resolved, result, retried };
}
