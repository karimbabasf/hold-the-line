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

stop() {
  pkill -f "telephony/server.ts" 2>/dev/null || true
  pkill -f "mcp/server.ts" 2>/dev/null || true
  pkill -f "@truefoundry/trueforge" 2>/dev/null || true
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  echo "stopped."
}
[ "${1:-}" = "--stop" ] && { stop; exit 0; }

[ -f .env.local ] || { echo "no .env.local. copy .env.example and fill it in."; exit 1; }

wait_for_port() {
  for _ in $(seq 1 60); do
    lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "timed out waiting for port $1. see $LOGS/"; exit 1
}

echo "stopping anything already running"
stop >/dev/null 2>&1 || true
sleep 1

echo "1/5  harness"
nohup npx -y @truefoundry/trueforge > "$LOGS/trueforge.log" 2>&1 &
wait_for_port 8790

echo "2/5  claim tools"
nohup node --experimental-strip-types src/mcp/server.ts > "$LOGS/mcp.log" 2>&1 &
wait_for_port 8792

echo "3/5  telephony"
nohup node --env-file=.env.local --experimental-strip-types src/telephony/server.ts > "$LOGS/telephony.log" 2>&1 &
wait_for_port 8791

echo "4/5  public tunnel"
nohup cloudflared tunnel --url http://localhost:8791 --no-autoupdate > "$LOGS/tunnel.log" 2>&1 &
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

cat <<EOF

up.
  harness    http://localhost:8790
  console    http://localhost:8791/console
  tunnel     $URL
  call       ${TELNYX_NUMBER:-+1 415 723 8926}

logs in $LOGS/ . stop with ./scripts/start.sh --stop
EOF
