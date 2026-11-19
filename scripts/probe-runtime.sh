#!/usr/bin/env bash
# Reproduces the "Could not load channels / HTTP 500" runtime failure modes
# against the built standalone server and prints the API responses.
set -u
APP=/home/z/my-project
PORT=3123
BASE="http://127.0.0.1:${PORT}"

start_server() { # $1 = DATA_DIR
  DATA_DIR="$1" PORT="$PORT" HOSTNAME=127.0.0.1 NODE_ENV=production \
    node "$APP/.next/standalone/server.js" >/tmp/probe-server.log 2>&1 &
  SRV=$!
  for i in $(seq 1 50); do
    curl -sf "$BASE/api/health" >/dev/null 2>&1 && return 0
    sleep 0.2
  done
  echo "SERVER FAILED TO START"; cat /tmp/probe-server.log; exit 1
}

stop_server() { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; }

show() { # $1 = label, $2 = url
  echo "── $1"
  curl -s -o /tmp/probe-body -w 'HTTP %{http_code}\n' "$2"
  head -c 600 /tmp/probe-body; echo; echo
}

# ── 1. healthy path: fresh writable data dir ────────────────────────────────
rm -rf /tmp/probe-clean && mkdir -p /tmp/probe-clean
start_server /tmp/probe-clean
show "HEALTH (clean)"            "$BASE/api/health"
show "CHANNELS (clean)"          "$BASE/api/channels"
show "STATUS (clean)"            "$BASE/api/status"
stop_server
echo "server log (clean):"; cat /tmp/probe-server.log; echo; echo

# ── 2. unwritable data dir (simulates Docker-created root-owned ./data) ──────
rm -rf /tmp/probe-ro && mkdir -p /tmp/probe-ro && chmod 555 /tmp/probe-ro
start_server /tmp/probe-ro
show "HEALTH (unwritable)"       "$BASE/api/health"
show "CHANNELS (unwritable)"     "$BASE/api/channels"
show "STATUS (unwritable)"       "$BASE/api/status"
stop_server
echo "server log (unwritable):"; cat /tmp/probe-server.log; echo; echo
chmod 755 /tmp/probe-ro

# ── 3. corrupt channels.json ────────────────────────────────────────────────
rm -rf /tmp/probe-bad && mkdir -p /tmp/probe-bad
printf '{ "channels": [ broken' > /tmp/probe-bad/channels.json
start_server /tmp/probe-bad
show "HEALTH (corrupt json)"     "$BASE/api/health"
show "CHANNELS (corrupt json)"   "$BASE/api/channels"
stop_server
echo "server log (corrupt):"; cat /tmp/probe-server.log
