#!/usr/bin/env bash
# Builds and ships the plugin to a Paperclip running in Docker on another machine
# (HOST, reached over ssh; container CONTAINER), then reloads it the clean way:
# disable + enable through Paperclip's CLI (board token approved once, stored in
# /paperclip/.claude-ops on the server). Copying files alone makes Paperclip's file
# watcher bounce the worker without its settings; the enable afterwards replaces
# that worker with a properly activated one.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${HOST:?set HOST to the ssh target running Paperclip, e.g. HOST=me@server}"
node --test test/*.test.ts 2>&1 | grep -E '^# (pass|fail)'
node build.mjs >/dev/null 2>&1
tar -czf - package.json dist | ssh -o BatchMode=yes "$HOST" 'rm -rf /tmp/pc-mm && mkdir -p /tmp/pc-mm && tar -xzf - -C /tmp/pc-mm'
ssh -o BatchMode=yes "$HOST" "REINSTALL=${REINSTALL:-} C=${CONTAINER:-paperclip-paperclip-1} zsh -l -s" <<'REMOTE'
set -e
pc() { docker exec $C sh -c "cd /app/cli && HOME=/paperclip/.claude-ops node --import ./node_modules/tsx/dist/loader.mjs src/index.ts $* --api-base http://localhost:\${PORT:-3101} --context /paperclip/.claude-ops/context.json"; }
docker cp /tmp/pc-mm/. $C:/paperclip/plugins/mattermost/
sleep 6
since=$(date +%s)
WANT=${WANT:-1} # Mattermost connections to wait for (bots + manager, all companies)
if [ -n "$REINSTALL" ]; then
  # New permissions, settings or UI are read only at install. Settings survive it.
  docker exec -i $C node <<'JS'
const fs = require("fs");
const find = (o) => { for (const v of Object.values(o ?? {})) { if (typeof v === "string" && v.startsWith("pcp_")) return v; const r = typeof v === "object" && find(v); if (r) return r; } };
const H = { Authorization: "Bearer " + find(JSON.parse(fs.readFileSync("/paperclip/auth.json", "utf8"))), "content-type": "application/json" };
const base = `http://localhost:${process.env.PORT || 3101}/api/plugins`;
(async () => {
  const del = await fetch(`${base}/mattermost-bridge`, { method: "DELETE", headers: H });
  const ins = await fetch(`${base}/install`, { method: "POST", headers: H, body: JSON.stringify({ packageName: "/paperclip/plugins/mattermost", isLocalPath: true }) });
  const j = await ins.json();
  console.log(`reinstall: delete ${del.status}, install ${ins.status} ${j.version ?? JSON.stringify(j).slice(0, 300)}`);
  if (!ins.ok) process.exit(1);
})();
JS
else
  pc plugin disable mattermost-bridge >/dev/null
  pc plugin enable mattermost-bridge >/dev/null
fi
ID=$(pc plugin list | grep -F mattermost-bridge | sed -E 's/.*id=([0-9a-f-]+).*/\1/')
for i in {1..40}; do
  m=$(docker logs --since "$since" $C 2>&1 | grep -F "$ID" | grep -cF 'connected to Mattermost' || true)
  [ "$m" -ge "$WANT" ] && break; sleep 3
done
echo "reloaded: $(pc plugin list | grep mattermost-bridge); $m Mattermost connections"
REMOTE
