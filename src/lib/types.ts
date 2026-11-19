/** Shared client/server types for the web viewer. */

export type ChannelStatus = 'online' | 'offline' | 'unknown' | 'checking';

export interface ApiChannel {
  id: string;
  name: string;
  group: string;
  logo?: string;
  tvgId?: string;
  resolver: string;
  status: ChannelStatus;
  lastChecked?: string;
}

export interface DirectInfo {
  url: string;
  expiresAt?: number;
  headers: Record<string, string>;
}

export interface SharePayload {
  channel: string;
  name: string;
  live: string;
  m3u8: string;
  playlist: string;
  direct?: DirectInfo | null;
  resolveError?: string;
  vlc: Record<string, string>;
  mpv: Record<string, string>;
}

export interface CheckResult {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
  status: Exclude<ChannelStatus, 'unknown' | 'checking'>;
}

export interface StatusInfo {
  version: string;
  node: string;
  uptimeSec: number;
  channels: number;
  online: number;
  memory: { rssMb: number; heapMb: number };
  cache: {
    playlists: { entries: number; max: number };
    segments: { entries: number; bytes: number };
    resolutions: { entries: number };
    headers: number;
  };
  config: {
    authRequired: boolean;
    shareTokenRequired: boolean;
    allowPrivateUpstreams: boolean;
    segCacheMb: number;
    segCacheTtlMs: number;
  };
}

export type OsChoice = 'posix' | 'powershell' | 'cmd';

export const OS_LABELS: Array<[OsChoice, string]> = [
  ['posix', 'Linux / macOS (sh)'],
  ['powershell', 'Windows (PowerShell)'],
  ['cmd', 'Windows (cmd.exe)'],
];
