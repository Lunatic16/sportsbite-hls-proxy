/** Internal channel data model (persisted in channels.json). */
export type ResolverKind = 'static' | 'm3u-source' | 'custom';

export interface Channel {
  /** Stable slug. */
  id: string;
  name: string;
  group?: string;
  logo?: string;
  tvgId?: string;
  resolver: ResolverKind;
  /** For static channels. */
  url?: string;
  /** Per-channel upstream headers (UA/Referer/Origin/Cookie/Authorization/...). */
  headers?: Record<string, string>;
  /** Resolver-specific options. */
  options?: Record<string, unknown>;
  /** 'online' | 'offline' | 'unknown' — maintained by `npm run check`. */
  status?: 'online' | 'offline' | 'unknown';
  lastChecked?: string;
}

/** What resolve() produces. */
export interface ResolvedStream {
  url: string;
  headers?: Record<string, string>;
  /** Unix ms when the URL is believed to expire; omit if stable/unknown. */
  expiresAt?: number;
}

export class ResolverError extends Error {
  constructor(message: string, public readonly retryable: boolean = false) {
    super(message);
    this.name = 'ResolverError';
  }
}

/** Headers safe to expose to authenticated UI users (never cookies/auth). */
export function publicHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  if (!headers) return {};
  const safe: Record<string, string> = {};
  for (const key of ['user-agent', 'referer', 'origin']) {
    const v = headers[key] ?? headers[key.toLowerCase()];
    if (v) safe[key.toLowerCase()] = v;
  }
  return safe;
}
