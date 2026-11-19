/**
 * Resolver registry + lazy resolution cache.
 *
 * - Resolving happens lazily on first request, never at startup.
 * - Resolved URLs are cached until expiresAt (or RESOLVE_TTL_MS default).
 * - Stream routes call resolveAndFetch(): on upstream 403/404/410 they force
 *   a re-resolve and retry the fetch once.
 *
 * The registry and cache live on globalThis so every Next.js route bundle
 * shares one instance.
 */
import { loadConfig } from '../config';
import type { Channel, ResolvedStream } from '../channels/types';
import { ResolverError } from '../channels/types';
import { getLogger } from '../logger';
import { staticResolver } from './static';
import { m3uSourceResolver } from './m3uSource';
import { sportsbiteResolver } from './sportsbite';
import { matchoraResolver } from './matchora';
import type { Resolver } from './types';

interface CacheEntry {
  resolved: ResolvedStream;
  expiresAt: number;
}

interface GlobalState {
  __iptvResolverRegistry?: Map<string, Resolver>;
  __iptvResolutionCache?: Map<string, CacheEntry>;
}

const g = globalThis as unknown as GlobalState;

function registry(): Map<string, Resolver> {
  if (!g.__iptvResolverRegistry) {
    g.__iptvResolverRegistry = new Map<string, Resolver>([
      ['static', staticResolver],
      ['m3u-source', m3uSourceResolver],
      ['sportsbite', sportsbiteResolver],
      ['matchora', matchoraResolver],
    ]);
  }
  return g.__iptvResolverRegistry;
}

function cache(): Map<string, CacheEntry> {
  if (!g.__iptvResolutionCache) g.__iptvResolutionCache = new Map();
  return g.__iptvResolutionCache;
}

/** Register your own resolver implementation at startup. */
export function registerResolver(name: string, resolver: Resolver): void {
  registry().set(name, resolver);
}

export function invalidateResolution(channelId: string): void {
  cache().delete(channelId.toLowerCase());
}

export function clearResolutionCache(): void {
  cache().clear();
}

export function resolutionCacheStats(): { entries: number } {
  return { entries: cache().size };
}

export async function resolveChannel(channel: Channel): Promise<ResolvedStream> {
  const key = channel.id.toLowerCase();
  const cfg = loadConfig();

  const cached = cache().get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.resolved;
  }

  const resolverKind =
    channel.resolver === 'custom'
      ? String(channel.options?.['custom'] ?? '')
      : channel.resolver;
  const resolver = registry().get(resolverKind);
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
  cache().set(key, { resolved, expiresAt: ttl });
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
