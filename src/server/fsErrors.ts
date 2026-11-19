/**
 * Human-friendly filesystem errors for the failure modes that hit every
 * self-hoster at least once:
 *   1. a bind-mounted data directory created by Docker as root (uid 0) while
 *      the container runs as uid 1000 → EACCES on every write,
 *   2. a corrupt / non-JSON channels.json,
 *   3. a read-only rootfs without a writable data mount.
 *
 * The returned message doubles as the fix instruction, because it is shown
 * verbatim in the web UI (channel list error panel) and in API error bodies.
 */
export function describeFsError(err: unknown, file: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? '';
  const msg = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'EACCES':
    case 'EPERM':
      return (
        `${file}: permission denied (${code}). The server runs as uid 1000 — ` +
        'if this is a Docker bind mount, fix ownership on the HOST: `sudo chown -R 1000:1000 ./data`, then restart the container.'
      );
    case 'EROFS':
      return (
        `${file}: read-only filesystem (${code}). The container filesystem is read-only — ` +
        'point DATA_DIR at a writable mount (docker-compose.yml maps ./data to /app/data).'
      );
    case 'ENOENT':
      return `${file}: not found (${code}) and could not be created (parent directory not writable?).`;
    case 'EISDIR':
      return `${file}: is a directory (EISDIR) — remove it or point CHANNELS_FILE elsewhere.`;
    default:
      return `${file}: ${msg}`;
  }
}
