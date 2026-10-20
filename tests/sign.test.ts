import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildProxyUrl,
  encodeUrlForProxy,
  decodeUrlForProxy,
  signProxyUrl,
  verifyProxyUrl,
  headersIdFor,
  shareTokens,
} from '../src/net/sign.js';
import { getChannelSecret, rotateChannelSecret } from '../src/net/shareStore.js';

const URL_A = 'https://ds169.bluetier.top/CH/tracks-v1a1/2026/10/19/19/46/57-07800.ts?token=abc.123';

describe('proxy URL signing', () => {
  it('round-trips encode/decode', () => {
    const enc = encodeUrlForProxy(URL_A);
    expect(decodeUrlForProxy(enc)).toBe(URL_A);
    expect(enc).not.toContain('?');
  });

  it('verifies a genuine signature and rejects tampering', () => {
    const enc = encodeUrlForProxy(URL_A);
    const hid = headersIdFor({ referer: 'https://sportsbite.org/' });
    const sig = signProxyUrl('segment', enc, hid);
    expect(verifyProxyUrl('segment', enc, hid, sig)).toBe(true);

    // swapped URL
    const encB = encodeUrlForProxy('https://evil.example/x.ts');
    expect(verifyProxyUrl('segment', encB, hid, sig)).toBe(false);
    // swapped headers id
    expect(verifyProxyUrl('segment', enc, 'other', sig)).toBe(false);
    // wrong kind (playlist URL replayed as segment)
    expect(verifyProxyUrl('playlist', enc, hid, sig)).toBe(false);
    // missing signature
    expect(verifyProxyUrl('segment', enc, hid, undefined)).toBe(false);
  });

  it('buildProxyUrl produces a verifiable URL that hides the upstream', () => {
    const hid = headersIdFor(undefined);
    const built = buildProxyUrl('key', 'http://proxy.local:3000', 'https://cdn.example/k.bin', hid);
    const u = new URL(built);
    expect(u.pathname).toBe('/proxy/key');
    expect(u.searchParams.get('url')).not.toContain('cdn.example');
    expect(verifyProxyUrl('key', u.searchParams.get('url')!, hid, u.searchParams.get('s')!)).toBe(true);
  });

  it('headersIdFor is deterministic and order-independent', () => {
    expect(headersIdFor({ a: '1', b: '2' })).toBe(headersIdFor({ b: '2', a: '1' }));
    expect(headersIdFor({ a: '1' })).not.toBe(headersIdFor({ a: '2' }));
    expect(headersIdFor(undefined)).toBe('none');
  });
});

describe('share tokens (per-channel scoping)', () => {
  const chA = '247-beinsportsus';
  const chB = 't247-abc';
  const secretA = 'channel-a-secret-aaaaaaaaaaaa';
  const secretB = 'channel-b-secret-bbbbbbbbbbbb';

  it('issues and verifies a non-expiring token', () => {
    const token = shareTokens.issue(chA, secretA);
    expect(shareTokens.verify(chA, token, secretA)).toBe(true);
  });

  it('rejects a token from another channel (single-channel scope)', () => {
    const token = shareTokens.issue(chA, secretA);
    expect(shareTokens.verify(chB, token, secretB)).toBe(false);
    // even with the same secret, the channel id is bound into the HMAC payload
    expect(shareTokens.verify(chB, token, secretA)).toBe(false);
  });

  it('rejects a wrong secret (rotated tokens die)', () => {
    const token = shareTokens.issue(chA, secretA);
    expect(shareTokens.verify(chA, token, 'rotated-secret-zzzzzzzzzzzz')).toBe(false);
  });

  it('rejects expired tokens', () => {
    const exp = Date.now() - 1000;
    const sig = createHmac('sha256', secretA).update(`share|${chA}|${exp}`).digest('hex').slice(0, 32);
    const expired = `${encodeURIComponent(chA)}.${exp}.${sig}`;
    expect(shareTokens.verify(chA, expired, secretA)).toBe(false);
  });

  it('rejects garbage and absent tokens', () => {
    expect(shareTokens.verify(chA, undefined, secretA)).toBe(false);
    expect(shareTokens.verify(chA, '', secretA)).toBe(false);
    expect(shareTokens.verify(chA, 'not-a-token', secretA)).toBe(false);
    expect(shareTokens.verify(chA, `${chA}.zzzz`, secretA)).toBe(false);
  });
});

describe('share token secrets (shareStore)', () => {
  it('persists a channel secret and rotates it on demand', () => {
    const ch = 'check-store-channel';
    const s1 = getChannelSecret(ch);
    expect(getChannelSecret(ch)).toBe(s1); // stable
    const s2 = rotateChannelSecret(ch);
    expect(s2).not.toBe(s1);
    expect(getChannelSecret(ch)).toBe(s2);
  });
});
