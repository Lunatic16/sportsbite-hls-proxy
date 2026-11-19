/** Static resolver: fixed URL (+ optional per-channel headers). */
import type { Channel, ResolvedStream } from '../channels/types';
import { ResolverError } from '../channels/types';
import type { Resolver } from './types';

export const staticResolver: Resolver = {
  name: 'static',

  async resolve(channel: Channel): Promise<ResolvedStream> {
    if (!channel.url) {
      throw new ResolverError(`channel "${channel.id}" (static) has no url`, false);
    }
    const ttlSeconds = typeof channel.options?.['ttlSeconds'] === 'number'
      ? (channel.options['ttlSeconds'] as number)
      : undefined;
    const resolved: ResolvedStream = {
      url: channel.url,
      headers: channel.headers,
    };
    if (ttlSeconds && ttlSeconds > 0) {
      resolved.expiresAt = Date.now() + ttlSeconds * 1000;
    }
    return resolved;
  },
};
