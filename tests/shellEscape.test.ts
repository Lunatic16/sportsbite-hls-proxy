import { describe, expect, it } from 'vitest';
import {
  posixQuote,
  powershellQuote,
  cmdQuote,
  shellQuote,
  buildVlcCommand,
  buildMpvCommand,
} from '../src/util/shellEscape.js';

describe('shell quoting', () => {
  it('posixQuote survives single quotes, $, backticks, spaces', () => {
    expect(posixQuote("he'llo")).toBe(`'he'\\''llo'`);
    expect(posixQuote('a b c')).toBe(`'a b c'`);
    expect(posixQuote('$HOME `id` $(id)')).toBe(`'$HOME \`id\` $(id)'`);
  });

  it('powershellQuote escapes inner single quotes by doubling', () => {
    expect(powershellQuote("he'llo")).toBe(`'he''llo'`);
    expect(powershellQuote('plain')).toBe(`'plain'`);
  });

  it('cmdQuote wraps in double quotes and doubles inner quotes', () => {
    expect(cmdQuote('a"b')).toBe(`"a""b"`);
    expect(cmdQuote('plain')).toBe(`"plain"`);
  });

  it('shellQuote dispatches per OS', () => {
    expect(shellQuote(`it's`, 'posix')).toBe(`'it'\\''s'`);
    expect(shellQuote(`it's`, 'powershell')).toBe(`'it''s'`);
    expect(shellQuote('x', 'cmd')).toBe('"x"');
  });
});

describe('player commands', () => {
  it('live URL needs no header flags', () => {
    const cmd = buildVlcCommand("http://p:3000/live/ch?token=a'b", undefined, 'posix');
    expect(cmd).toBe(`vlc 'http://p:3000/live/ch?token=a'\\''b'`);
    expect(cmd).not.toContain('--http-user-agent');
  });

  it('direct VLC command carries UA + referrer with proper quoting', () => {
    const cmd = buildVlcCommand(
      'https://up.example/pl.m3u8',
      { 'user-agent': 'Firefox/130.0', referer: 'https://sportsbite.org/' },
      'posix',
    );
    expect(cmd).toBe(`vlc 'https://up.example/pl.m3u8' --http-user-agent='Firefox/130.0' --http-referrer='https://sportsbite.org/'`);
  });

  it('direct MPV command carries UA, referrer and Origin header field', () => {
    const cmd = buildMpvCommand(
      'https://up.example/pl.m3u8',
      { 'user-agent': 'UA$X', referer: 'https://r/', origin: 'https://o' },
      'posix',
    );
    expect(cmd).toBe(`mpv 'https://up.example/pl.m3u8' --user-agent='UA$X' --referrer='https://r/' --http-header-fields='Origin: https://o'`);
  });

  it('Windows variants use their own quoting', () => {
    const cmd = buildVlcCommand(
      'https://up.example/x.m3u8',
      { referer: `https://r/'q` },
      'powershell',
    );
    expect(cmd).toContain(`--http-referrer='https://r/''q'`);
    const cmd2 = buildMpvCommand('https://up.example/x.m3u8', { referer: 'https://r/' }, 'cmd');
    expect(cmd2).toBe(`mpv "https://up.example/x.m3u8" --referrer="https://r/"`);
  });

  it('headers without UA/referer/origin add no flags', () => {
    const cmd = buildMpvCommand('https://up.example/x', { cookie: 'a=b' }, 'posix');
    expect(cmd).toBe(`mpv 'https://up.example/x'`);
  });
});
