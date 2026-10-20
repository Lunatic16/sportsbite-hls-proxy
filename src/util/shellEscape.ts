/**
 * VLC / MPV command builders with correct shell escaping.
 *
 * POSIX: single-quote wrapping with '\'' escaping (safe for quotes, spaces,
 * $, backticks, everything).
 * PowerShell: single-quote wrapping with '' escaping.
 * cmd.exe: double-quote wrapping with "" for inner quotes (best effort —
 * cmd has no fully general quoting; documented in the README).
 */
export type ShellOs = 'posix' | 'powershell' | 'cmd';

export interface PlaybackHeaders {
  'user-agent'?: string;
  referer?: string;
  origin?: string;
  [key: string]: string | undefined;
}

export function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, `''`)}'`;
}

export function cmdQuote(value: string): string {
  // cmd.exe: outer double quotes; inner quotes doubled; % needs care only in
  // batch files (interactive shell keeps %VAR% behavior — documented).
  return `"${value.replace(/"/g, `""`)}"`;
}

export function shellQuote(value: string, os: ShellOs): string {
  switch (os) {
    case 'powershell':
      return powershellQuote(value);
    case 'cmd':
      return cmdQuote(value);
    default:
      return posixQuote(value);
  }
}

function flag(os: ShellOs, flagName: string, value: string): string {
  return `${flagName}=${shellQuote(value, os)}`;
}

/**
 * VLC: Direct-URL playback needs `--http-user-agent` / `--http-referrer`.
 * The proxied Live URL needs nothing.
 */
export function buildVlcCommand(url: string, headers: PlaybackHeaders | undefined, os: ShellOs): string {
  const parts = ['vlc', shellQuote(url, os)];
  const h = headers ?? {};
  if (h['user-agent']) parts.push(flag(os, '--http-user-agent', h['user-agent']));
  if (h['referer']) parts.push(flag(os, '--http-referrer', h['referer']));
  return parts.join(' ');
}

/**
 * MPV: `--user-agent`, `--referrer`, and arbitrary headers via
 * `--http-header-fields='Name: value'` (repeated per header).
 */
export function buildMpvCommand(url: string, headers: PlaybackHeaders | undefined, os: ShellOs): string {
  const parts = ['mpv', shellQuote(url, os)];
  const h = headers ?? {};
  if (h['user-agent']) parts.push(flag(os, '--user-agent', h['user-agent']));
  if (h['referer']) parts.push(flag(os, '--referrer', h['referer']));
  if (h['origin']) parts.push(flag(os, '--http-header-fields', `Origin: ${h['origin']}`));
  return parts.join(' ');
}
