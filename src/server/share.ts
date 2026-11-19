/**
 * Share & export payload builder: live/m3u8/direct URLs + VLC/MPV commands.
 * Pure functions — unit-testable without a Next.js runtime.
 */
import type { ResolvedStream } from './channels/types';
import { publicHeaders } from './channels/types';
import { shareTokens } from './sign';
import { getChannelSecret } from './shareStore';
import { buildVlcCommand, buildMpvCommand, type ShellOs } from './shellEscape';

const OS_VARIANTS: ShellOs[] = ['posix', 'powershell', 'cmd'];

export interface DirectPayload {
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
  direct?: DirectPayload;
  vlc: Record<string, string>;
  mpv: Record<string, string>;
}

export function buildSharePayload(
  channel: { id: string; name: string },
  base: string,
  resolved: ResolvedStream | undefined,
): SharePayload {
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

export function osSuffix(os: ShellOs): string {
  return os === 'posix' ? '' : os === 'powershell' ? 'Win' : 'Cmd';
}
