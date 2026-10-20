/**
 * Server-side registry of sensitive header sets. Proxy URLs reference a set
 * by its short ID (`h=` param) — header values themselves never appear in
 * URLs. In-memory only: a restart clears it, and clients naturally re-resolve
 * through /live or /stream, which re-register and mint fresh proxy URLs.
 */
import { headersIdFor } from '../net/sign.js';
import type { UpstreamHeaders } from '../net/fetchUpstream.js';

type AnyHeaders = Record<string, string | undefined>;

const registry = new Map<string, UpstreamHeaders>();

export function registerHeaders(headers: AnyHeaders | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return 'none';
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && v.length > 0) clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return 'none';
  const id = headersIdFor(clean);
  if (!registry.has(id)) {
    registry.set(id, clean as UpstreamHeaders);
    if (registry.size > 2048) {
      // Trim oldest entries (Map preserves insertion order).
      const first = registry.keys().next().value;
      if (first) registry.delete(first);
    }
  }
  return id;
}

export function lookupHeaders(id: string | undefined): UpstreamHeaders | undefined {
  if (!id || id === 'none') return undefined;
  return registry.get(id);
}
