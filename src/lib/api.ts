/** Typed API client: token attachment, structured errors, endpoint wrappers. */
import type { ApiChannel, CheckResult, SharePayload, StatusInfo } from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the caller is not authenticated (401) or the token is bad (403). */
  get isAuthError(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

let tokenProvider: () => string = () => '';

/** Wire the client to the current auth token (set once by the viewer). */
export function setTokenProvider(fn: () => string): void {
  tokenProvider = fn;
}

export function currentToken(): string {
  return tokenProvider();
}

function withToken(path: string): string {
  const token = tokenProvider();
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = tokenProvider();
  const res = await fetch(withToken(path), {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(token ? { 'x-auth-token': token } : {}) },
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `HTTP ${res.status}`);
  return body;
}

// ── typed endpoints ─────────────────────────────────────────────────────────

export interface ChannelsResponse {
  total: number;
  count: number;
  base: string;
  channels: ApiChannel[];
}

export function fetchChannels(search?: string, group?: string): Promise<ChannelsResponse> {
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (group && group !== '__all') qs.set('group', group);
  const suffix = qs.toString() ? `?${qs.toString()}` : '';
  return api<ChannelsResponse>(`/api/channels${suffix}`);
}

export function fetchShare(channelId: string): Promise<SharePayload> {
  return api<SharePayload>(`/api/channels/${encodeURIComponent(channelId)}/share`);
}

export function refreshDirect(channelId: string): Promise<{ ok: boolean }> {
  return api(`/api/channels/${encodeURIComponent(channelId)}/refresh`, { method: 'POST' });
}

export function rotateToken(channelId: string): Promise<{ ok: boolean; live: string; m3u8: string }> {
  return api(`/api/channels/${encodeURIComponent(channelId)}/rotate-token`, { method: 'POST' });
}

export function checkChannel(channelId: string): Promise<CheckResult> {
  return api<CheckResult>(`/api/channels/${encodeURIComponent(channelId)}/check`, { method: 'POST' });
}

export function reloadChannels(): Promise<{ ok: boolean; channels: number }> {
  return api('/api/reload', { method: 'POST' });
}

export function fetchStatus(): Promise<StatusInfo> {
  return api<StatusInfo>('/api/status');
}

export function fetchHealth(): Promise<{ ok: boolean; version: string }> {
  return api('/api/health');
}
