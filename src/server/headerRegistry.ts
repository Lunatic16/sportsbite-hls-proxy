/**
 * Server-side registry of sensitive header sets. Proxy URLs reference a set
 * by its short ID (`h=` param) — header values themselves never appear in
 * URLs. In-memory only: a restart clears it, and clients naturally re-resolve
 * through /live or /stream, which re-register and mint fresh proxy URLs.
 * Memoized on globalThis so every route shares one registry.
 */
import { headersIdFor } from './sign';

type AnyHeaders = Record<string, string | undefined>;

interface GlobalState {
  __iptvHeaderRegistry?: Map<string, AnyHeaders>;
}

const g = globalThis as unknown as GlobalState;

function registry(): Map<string, AnyHeaders> {
  if (!g.__iptvHeaderRegistry) g.__iptvHeaderRegistry = new Map();
  return g.__iptvHeaderRegistry;
}

export function registerHeaders(headers: AnyHeaders | undefined): string {
  if (!headers || Object.keys(headers).length === 0) return 'none';
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' && v.length > 0) clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return 'none';
  const id = headersIdFor(clean);
  const reg = registry();
  if (!reg.has(id)) {
    reg.set(id, clean);
    if (reg.size > 2048) {
      // Trim oldest entries (Map preserves insertion order).
      const first = reg.keys().next().value;
      if (first) reg.delete(first);
    }
  }
  return id;
}

export function lookupHeaders(id: string | undefined): AnyHeaders | undefined {
  if (!id || id === 'none') return undefined;
  return registry().get(id);
}

export function headerRegistrySize(): number {
  return registry().size;
}

export function clearHeaderRegistry(): void {
  registry().clear();
}
