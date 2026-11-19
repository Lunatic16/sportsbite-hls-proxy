#!/bin/sh
# iptv-stream-proxy container entrypoint.
#
# Docker creates missing bind-mount host directories as root:root, which left
# ./data unwritable for the app's uid 1000 and produced the infamous
# "Could not load channels / EACCES" on first run. This entrypoint starts as
# root, fixes ownership of the writable data dir once, then immediately drops
# to an unprivileged user for the actual server — the same pattern as the
# official postgres/redis images (they use gosu; alpine ships the tiny
# su-exec). After the drop, the server runs WITHOUT any capabilities.
#
# Override PUID/PGID when the host user is not uid 1000 (NAS boxes etc.):
#   PUID=1026 PGID=100 docker compose up -d
# Or run fully unprivileged and skip the fix entirely:
#   docker run --user 1000:1000 iptv-stream-proxy   (chown step is skipped)

set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${DATA_DIR:-/app/data}"

# Already unprivileged (docker run --user, Kubernetes, podman --userns) —
# nothing we can fix from here; exec the server as-is.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

# First run with a fresh volume: make sure the data dir exists.
mkdir -p "$DATA_DIR" 2>/dev/null || true

# Take ownership only when it is actually wrong (root-owned first run, or a
# PUID/PGID change) — avoids an expensive recursive chown on every restart.
cur_owner="$(stat -c '%u:%g' "$DATA_DIR" 2>/dev/null || true)"
if [ "$cur_owner" != "${PUID}:${PGID}" ]; then
  echo "[entrypoint] fixing ownership of $DATA_DIR -> ${PUID}:${PGID} (was ${cur_owner:-unknown})"
  chown -R "${PUID}:${PGID}" "$DATA_DIR" || {
    echo "[entrypoint] WARNING: could not chown $DATA_DIR to ${PUID}:${PGID}." >&2
    echo "[entrypoint] The app will report permission errors until you run on the host:" >&2
    echo "[entrypoint]   sudo chown -R ${PUID}:${PGID} ./data" >&2
  }
fi

# Drop privileges permanently and run the server.
exec su-exec "${PUID}:${PGID}" "$@"
