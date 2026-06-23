#!/bin/sh
# Session resume: a claude channel survives a bridge restart, resuming the same
# conversation. Uses a fake `claude` that records its args (no real claude needed).
set -e
cd "$(dirname "$0")/.."
WS="$PWD/node_modules/ws"
STATE=/tmp/gab-resume-state.json; FLOG=/tmp/gab-fake-claude.log; PORT=4855
rm -f "$STATE" "$FLOG"
mkdir -p /tmp/gab-fake
printf '#!/bin/sh\necho "ARGS: $*" >> %s\nexec sleep 120\n' "$FLOG" > /tmp/gab-fake/claude
chmod +x /tmp/gab-fake/claude

GABRIELE_STATE=$STATE GABRIELE_PORT=$PORT node bridge/server.js > /tmp/gab-b1.log 2>&1 &
B1=$!; sleep 1.5
node -e "const W=require('$WS');const ws=new W('ws://localhost:$PORT');ws.on('open',()=>{ws.send(JSON.stringify({type:'new',cmd:'/tmp/gab-fake/claude',cols:80,rows:24}));setTimeout(()=>process.exit(0),600);});"
sleep 1
UUID=$(node -e "console.log((JSON.parse(require('fs').readFileSync('$STATE'))[0]||{}).sessionId||'')")
kill -9 $B1 2>/dev/null; sleep 1; pkill -9 -f "/tmp/gab-fake/claude" 2>/dev/null; sleep 1

GABRIELE_STATE=$STATE GABRIELE_PORT=$PORT node bridge/server.js > /tmp/gab-b2.log 2>&1 &
B2=$!; sleep 2
RC=0
grep -q -- "--session-id $UUID" "$FLOG" && echo "✓ create used --session-id <uuid>" || { echo "✗ no --session-id"; RC=1; }
grep -q -- "--resume $UUID" "$FLOG"     && echo "✓ restart used --resume <SAME uuid>" || { echo "✗ no matching --resume"; RC=1; }
grep -qi "restoring 1 channel" /tmp/gab-b2.log && echo "✓ bridge logged the restore" || { echo "✗ no restore log"; RC=1; }
kill -9 $B2 2>/dev/null; pkill -9 -f "/tmp/gab-fake/claude" 2>/dev/null; rm -f "$STATE"
[ $RC -eq 0 ] && echo "ALL GREEN" || echo "FAILURES"
exit $RC
