/** Resolve a possibly-relative URI against a base URL. Returns null if unresolvable. */
export function resolveUri(uri: string, baseUrl: string): string | null {
  try {
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}
