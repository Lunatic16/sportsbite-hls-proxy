import { describe, expect, it } from 'vitest';
import { isPrivateIp, validateUpstreamUrl } from '../src/net/ssrf.js';

describe('isPrivateIp — IPv4', () => {
  const privateCases = [
    '127.0.0.1',
    '127.8.8.8',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // cloud metadata
    '169.254.0.1',
    '0.0.0.0',
    '100.64.0.1', // CGNAT (Docker host gateway neighbors)
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.1', // TEST-NET
  ];
  for (const ip of privateCases) {
    it(`blocks ${ip}`, () => expect(isPrivateIp(ip)).toBe(true));
  }

  const publicCases = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1'];
  for (const ip of publicCases) {
    it(`allows ${ip}`, () => expect(isPrivateIp(ip)).toBe(false));
  }
});

describe('isPrivateIp — IPv6', () => {
  it('blocks ::1', () => expect(isPrivateIp('::1')).toBe(true));
  it('blocks ::', () => expect(isPrivateIp('::')).toBe(true));
  it('blocks fe80::1 (link-local)', () => expect(isPrivateIp('fe80::1')).toBe(true));
  it('blocks fd00::1 (ULA)', () => expect(isPrivateIp('fd00::1')).toBe(true));
  it('blocks ff02::1 (multicast)', () => expect(isPrivateIp('ff02::1')).toBe(true));
  it('blocks IPv4-mapped loopback (::ffff:7f00:1)', () =>
    expect(isPrivateIp('::ffff:7f00:1')).toBe(true));
  it('blocks IPv4-mapped loopback dotted form', () =>
    expect(isPrivateIp('::ffff:127.0.0.1')).toBe(true));
  it('blocks IPv4-mapped private (::ffff:ac10:1 = 172.16.0.1)', () =>
    expect(isPrivateIp('::ffff:ac10:1')).toBe(true));
  it('blocks NAT64-wrapped loopback', () => expect(isPrivateIp('64:ff9b::7f00:1')).toBe(true));
  it('allows public IPv6', () => expect(isPrivateIp('2606:4700:4700::1111')).toBe(false));
});

describe('validateUpstreamUrl', () => {
  it('rejects non-http schemes', () => {
    expect(validateUpstreamUrl('file:///etc/passwd', false).ok).toBe(false);
    expect(validateUpstreamUrl('ftp://example.com/x', false).ok).toBe(false);
    expect(validateUpstreamUrl('gopher://example.com', false).ok).toBe(false);
  });

  it('rejects loopback/private/metadata hosts by name or literal', () => {
    expect(validateUpstreamUrl('http://localhost:8080/x', false).ok).toBe(false);
    expect(validateUpstreamUrl('http://127.0.0.1:8080/x', false).ok).toBe(false);
    expect(validateUpstreamUrl('http://169.254.169.254/latest/meta-data', false).ok).toBe(false);
    expect(validateUpstreamUrl('http://192.168.1.10/stream.m3u8', false).ok).toBe(false);
    expect(validateUpstreamUrl('http://[::1]:3000/x', false).ok).toBe(false);
    expect(validateUpstreamUrl('http://metadata.google.internal/computeMetadata', false).ok).toBe(false);
    expect(validateUpstreamUrl('http://my-box.local/x', false).ok).toBe(false);
  });

  it('rejects credentials embedded in URLs', () => {
    expect(validateUpstreamUrl('http://user:pass@example.com/x', false).ok).toBe(false);
  });

  it('allows public http(s) URLs', () => {
    expect(validateUpstreamUrl('http://sportsbite.org/247/beinsportsus', false).ok).toBe(true);
    expect(validateUpstreamUrl('https://p16-common-sign.tiktokcdn-us.com/x.image?a=b', false).ok).toBe(true);
  });

  it('allowPrivate=true opens LAN targets (documented opt-in)', () => {
    expect(validateUpstreamUrl('http://192.168.1.10:8080/live.m3u8', true).ok).toBe(true);
    expect(validateUpstreamUrl('http://localhost:9999/x', true).ok).toBe(true);
  });

  it('rejects unparseable URLs', () => {
    expect(validateUpstreamUrl('not a url', false).ok).toBe(false);
  });
});
