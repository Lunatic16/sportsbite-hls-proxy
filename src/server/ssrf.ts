/**
 * SSRF guard: block loopback / link-local / private / reserved ranges unless
 * ALLOW_PRIVATE_UPSTREAMS=true. Only http/https schemes are allowed.
 *
 * Checks happen twice: on the URL literal (fast, friendly errors) and again at
 * connect time via a custom DNS lookup installed on the undici Agent, which
 * closes the DNS-rebinding window (resolved IPs are re-validated).
 */

import dns from 'node:dns';

export interface SsrfVerdict {
  ok: boolean;
  reason?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

/** Is this IPv4/IPv6 address in a private/reserved/loopback/link-local range? */
export function isPrivateIp(address: string): boolean {
  const ip = address.toLowerCase();

  // ── IPv4 ──
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    const o = ip.split('.').map(Number);
    if (o.some((n) => Number.isNaN(n) || n > 255)) return true;
    return (
      o[0] === 0 ||
      o[0] === 10 ||
      (o[0] === 100 && o[1] >= 64 && o[1] <= 127) || // CGNAT
      o[0] === 127 ||
      (o[0] === 169 && o[1] === 254) || // link-local incl. cloud metadata
      (o[0] === 172 && o[1] >= 16 && o[1] <= 31) ||
      (o[0] === 192 && o[1] === 0 && o[2] === 0) ||
      (o[0] === 192 && o[1] === 0 && o[2] === 2) ||
      (o[0] === 192 && o[1] === 168) ||
      (o[0] === 198 && (o[1] === 18 || o[1] === 19)) ||
      (o[0] === 198 && o[1] === 51 && o[2] === 100) ||
      (o[0] === 203 && o[1] === 0 && o[2] === 113) ||
      o[0] >= 224 // multicast + reserved
    );
  }

  // ── IPv6 ──
  if (ip.includes(':')) {
    // IPv4-mapped / IPv4-compatible forms: check the embedded IPv4.
    // WHATWG URL serializes ::ffff:127.0.0.1 as ::ffff:7f00:1 — handle both.
    const mapped = ip.match(/^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
    if (mapped) {
      if (mapped[1]) return isPrivateIp(mapped[1]);
      const hi = parseInt(mapped[2], 16);
      const lo = parseInt(mapped[3], 16);
      return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    // NAT64 64:ff9b::/96 embeds an IPv4 in the last 32 bits.
    if (ip.startsWith('64:ff9b::')) {
      const tail = ip.slice(9);
      const m = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (m) {
        const hi = parseInt(m[1], 16);
        const lo = parseInt(m[2], 16);
        return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
      }
    }
    const groups = expandIpv6(ip);
    if (!groups) return true; // unparsable → treat as unsafe
    // ::/128 unspecified, ::1/128 loopback
    if (groups.every((g) => g === 0)) return true;
    if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return true;
    // fc00::/7 unique local
    if ((groups[0] & 0xfe00) === 0xfc00) return true;
    // fe80::/10 link-local
    if ((groups[0] & 0xffc0) === 0xfe80) return true;
    // ff00::/8 multicast
    if ((groups[0] & 0xff00) === 0xff00) return true;
    // 2001:db8::/32 documentation (never routable)
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;
    return false;
  }

  // Not an IP literal — hostname, judged by DNS at connect time.
  return false;
}

function expandIpv6(ip: string): number[] | undefined {
  // supports :: compression; returns 8 groups of 16 bits
  let head: string[];
  let tail: string[];
  if (ip.includes('::')) {
    const [h, t = ''] = ip.split('::');
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  } else {
    head = ip.split(':');
    tail = [];
  }
  if (head.length + tail.length > 8) return undefined;
  const fill = 8 - head.length - tail.length;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (groups.length !== 8) return undefined;
  const nums: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    nums.push(parseInt(g, 16));
  }
  return nums;
}

/** Fast validation of the URL literal itself (DNS still checked at connect). */
export function validateUpstreamUrl(rawUrl: string, allowPrivate: boolean): SsrfVerdict {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `scheme ${url.protocol} not allowed (http/https only)` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'credentials in URL are not allowed' };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
      return { ok: false, reason: `host "${host}" is not a public address` };
    }
    if (isPrivateIp(host)) {
      return { ok: false, reason: `host "${host}" resolves to a private/reserved range` };
    }
  }
  return { ok: true };
}

export function assertUpstreamAllowed(rawUrl: string, allowPrivate: boolean): void {
  const v = validateUpstreamUrl(rawUrl, allowPrivate);
  if (!v.ok) throw new SsrfError(v.reason ?? 'blocked by SSRF guard');
}

export class SsrfError extends Error {
  constructor(reason: string) {
    super(`Upstream blocked: ${reason}`);
    this.name = 'SsrfError';
  }
}

/**
 * DNS lookup function for the undici Agent. Resolves all addresses, filters
 * out private ones (unless allowed) and honors undici's `opts.all` callback
 * shape — otherwise every connection silently fails.
 */
export function createSafeLookup(allowPrivate: boolean): (
  hostname: string,
  options: { all: boolean },
  callback: (err: NodeJS.ErrnoException | null, address?: unknown) => void,
) => void {
  return (hostname, options, callback) => {
    dns.lookup(
      hostname,
      { all: true, verbatim: true },
      (err: NodeJS.ErrnoException | null, addresses) => {
        if (err) {
          callback(err);
          return;
        }
        if (!addresses || addresses.length === 0) {
          callback(new Error(`no addresses for ${hostname}`));
          return;
        }
        const allowed = allowPrivate
          ? addresses
          : addresses.filter((a) => !isPrivateIp(a.address));
        if (allowed.length === 0) {
          const e = new Error(
            `all addresses of ${hostname} are in private/reserved ranges (SSRF guard)`,
          ) as NodeJS.ErrnoException;
          e.code = 'ENOTFOUND';
          callback(e);
          return;
        }
        if (options.all) {
          callback(null, allowed.map((a) => ({ address: a.address, family: a.family })));
        } else {
          callback(null, allowed[0].address);
        }
      },
    );
  };
}
