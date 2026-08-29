#!/usr/bin/env bash
# Bring the whole stack up and point Telnyx at it.
#
# Four processes have to be running in the right order, and the tunnel hands
# out a new hostname every time, so the Telnyx assistant needs repointing on
# every restart. Doing that from memory at 9am in a noisy room is how a demo
# gets lost, hence this.
#
#   ./scripts/start.sh          bring everything up
#   ./scripts/start.sh --stop   put it all down
set -euo pipefail
cd "$(dirname "$0")/.."

LOGS=".run"; mkdir -p "$LOGS"
PIDFILE="$LOGS/pids"

# Teardown kills only what this checkout started, by pid.
#
# It used to be `pkill -f "telephony/server.ts"`, which matches on a command
# line substring and so reaches into every other checkout on the machine. A
# second worktree running its own stack, or a colleague's cloudflared, died
# every time anyone here ran `npm start`. A pid file is the ownership record
# that substring never was.
record_pid() { echo "$1" >> "$PIDFILE"; }

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}

stop() {
  [ -f "$PIDFILE" ] || { echo "nothing recorded as running."; return 0; }
  while read -r pid; do
    [ -n "$pid" ] && kill_tree "$pid"
  done < "$PIDFILE"
  rm -f "$PIDFILE"
  echo "stopped."
}
[ "${1:-}" = "--stop" ] && { stop; exit 0; }

[ -f .env.local ] || { echo "no .env.local. copy .env.example and fill it in."; exit 1; }

# A half-built stack is worse than none: it answers on some ports and not
# others, so the next failure looks like a code bug. Any non-zero exit from
# here on tears down whatever this run managed to start.
started_clean=0
cleanup() {
  [ "$started_clean" = "1" ] && return 0
  echo "startup failed, putting back what it started"
  stop >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Succeeds only when the port is held by the child we just launched, or by one
# of its descendants (npx and node --env-file both fork). A bare "is anything
# listening" check passed when our own server failed to bind and something
# unrelated already owned the port, and step 5 then pointed Telnyx at a
# stranger.
owns_port() {
  local want="$1" port="$2" holder ancestor
  for holder in $(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true); do
    ancestor="$holder"
    while [ -n "$ancestor" ] && [ "$ancestor" != "1" ]; do
      [ "$ancestor" = "$want" ] && { record_pid "$holder"; return 0; }
      ancestor=$(ps -o ppid= -p "$ancestor" 2>/dev/null | tr -d ' ')
    done
  done
  return 1
}

wait_for_port() {
  local port="$1" pid="$2" name="$3"
  for _ in $(seq 1 60); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$name exited before it listened. see $LOGS/"; exit 1
    fi
    owns_port "$pid" "$port" && return 0
    sleep 1
  done
  echo "timed out waiting for $name on port $port. see $LOGS/"; exit 1
}

echo "stopping anything this checkout started"
stop >/dev/null 2>&1 || true
: > "$PIDFILE"
sleep 1

echo "1/5  harness"
nohup npx -y @truefoundry/trueforge > "$LOGS/trueforge.log" 2>&1 &
record_pid $!; wait_for_port 8790 $! harness

echo "2/5  claim tools"
nohup node --experimental-strip-types src/mcp/server.ts > "$LOGS/mcp.log" 2>&1 &
record_pid $!; wait_for_port 8792 $! "claim tools"

echo "3/5  telephony"
nohup node --env-file=.env.local --experimental-strip-types src/telephony/server.ts > "$LOGS/telephony.log" 2>&1 &
record_pid $!; wait_for_port 8791 $! telephony

echo "4/5  public tunnel"
nohup cloudflared tunnel --url http://localhost:8791 --no-autoupdate > "$LOGS/tunnel.log" 2>&1 &
record_pid $!
URL=""
for _ in $(seq 1 60); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOGS/tunnel.log" 2>/dev/null | head -1 || true)
  [ -n "$URL" ] && break
  sleep 1
done
[ -n "$URL" ] || { echo "tunnel gave no URL. see $LOGS/tunnel.log"; exit 1; }

echo "5/5  pointing Telnyx at $URL"
node --env-file=.env.local scripts/telnyx-assistant.mts --point "$URL"

# Registering the MCP server is idempotent and cheap, and forgetting it means
# the agent answers with no tools at all, which looks like a model problem.
node --env-file=.env.local -e '
const F = "http://localhost:8790/api/v1";
await fetch(`${F}/settings/mcp-servers`, { method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "northvane", url: "http://localhost:8792/mcp" }) }).catch(() => {});
const t = await fetch(`${F}/mcp-servers/northvane/tools`).then(r => r.json()).catch(() => ({}));
const n = (t.data ?? t.tools ?? []).length;
console.log(`     ${n} tools registered`);
if (!n) { console.error("     NO TOOLS. the agent will answer with nothing."); process.exit(1); }
'

# The agent itself. Editing agent.json used to change nothing, because the only
# thing that ever created the agent was a one-off POST in the README and a
# repeat of that returns 409. Publishing on every start is what makes an edit to
# the instructions reach a running assistant.
echo "     publishing agent.json"
node --env-file=.env.local scripts/publish-agent.mjs

started_clean=1

cat <<EOF

up.
  harness    http://localhost:8790
  console    http://localhost:8791/console
  tunnel     $URL
  call       ${TELNYX_NUMBER:-+1 415 723 8926}

logs in $LOGS/ . stop with ./scripts/start.sh --stop
EOF
