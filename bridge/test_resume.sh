#!/bin/sh
# Session resume: a claude channel survives a bridge restart. Two branches:
#   • transcript PRESENT — the prior conversation is on disk → --resume <id>.
#   • transcript ABSENT  — claude died before saving → start FRESH under the SAME
#     stable id (--session-id <id>), so the channel is usable instead of a dead
#     "No conversation found with session ID <id>" screen.
# Hermetic: a fake `claude` records its args, and HOME points at a throwaway dir so
# we only ever read/plant transcripts under a fake ~/.claude — never the real one.
# pkill is scoped to the fake claude path, so real claude sessions are untouched.
# No `set -e`: kill/pkill/grep legitimately return non-zero; correctness is tracked in RC.
cd "$(dirname "$0")/.."
ROOT="$PWD"
WS="$PWD/node_modules/ws"
PORT=4855
HOME_DIR=/tmp/gab-home
STATE=/tmp/gab-resume-state.json
FLOG=/tmp/gab-fake-claude.log
# claude's projects dir name = cwd with every non-alphanumeric char turned into '-'.
SLUG=$(printf '%s' "$ROOT" | tr -c 'A-Za-z0-9' '-')
TDIR="$HOME_DIR/.claude/projects/$SLUG"

rm -rf "$HOME_DIR"; rm -f "$STATE" "$FLOG"
mkdir -p /tmp/gab-fake "$TDIR"
printf '#!/bin/sh\necho "ARGS: $*" >> %s\nexec sleep 120\n' "$FLOG" > /tmp/gab-fake/claude
chmod +x /tmp/gab-fake/claude

start_bridge() { # $1 = logfile
  HOME=$HOME_DIR GABRIELE_STATE=$STATE GABRIELE_PORT=$PORT node bridge/server.js > "$1" 2>&1 &
  BPID=$!; sleep 1.5
}
stop_bridge() {
  kill -9 $BPID 2>/dev/null; wait $BPID 2>/dev/null  # wait reaps it quietly (no async "Killed" noise)
  pkill -9 -f "/tmp/gab-fake/claude" 2>/dev/null; sleep 0.5  # scoped: only the fake claude
}

RC=0

# ---- create one fake-claude channel, capture its stable id ----
start_bridge /tmp/gab-b1.log
node -e "const W=require('$WS');const ws=new W('ws://localhost:$PORT');ws.on('open',()=>{ws.send(JSON.stringify({type:'new',cmd:'/tmp/gab-fake/claude',cols:80,rows:24}));setTimeout(()=>process.exit(0),600);});"
sleep 1
UUID=$(node -e "console.log((JSON.parse(require('fs').readFileSync('$STATE'))[0]||{}).sessionId||'')")
stop_bridge
[ -n "$UUID" ] && echo "✓ channel persisted with id $UUID" || { echo "✗ no persisted session id"; RC=1; }
grep -q -- "--session-id $UUID" "$FLOG" && echo "✓ fresh create used --session-id <uuid>" || { echo "✗ create did not use --session-id"; RC=1; }

# ---- branch 1: transcript PRESENT → restart must --resume the SAME id ----
mkdir -p "$TDIR"; : > "$TDIR/$UUID.jsonl"   # plant the saved conversation
: > "$FLOG"                                  # watch only the restart's args
start_bridge /tmp/gab-b2.log
stop_bridge
grep -qi "restoring 1 channel" /tmp/gab-b2.log && echo "✓ bridge logged the restore" || { echo "✗ no restore log"; RC=1; }
grep -q -- "--resume $UUID" "$FLOG" && echo "✓ transcript PRESENT → --resume <same uuid>" || { echo "✗ present transcript did not --resume"; RC=1; }

# ---- branch 2: transcript ABSENT → restart must start FRESH under the SAME id ----
rm -f "$TDIR/$UUID.jsonl"                    # conversation gone (claude died pre-save)
: > "$FLOG"
start_bridge /tmp/gab-b3.log
stop_bridge
grep -q -- "--session-id $UUID" "$FLOG" && echo "✓ transcript ABSENT → --session-id <same uuid> (fresh)" || { echo "✗ absent transcript did not --session-id"; RC=1; }
if grep -q -- "--resume" "$FLOG"; then echo "✗ absent transcript wrongly used --resume"; RC=1; else echo "✓ absent transcript did NOT --resume"; fi

rm -rf "$HOME_DIR"; rm -f "$STATE"
[ $RC -eq 0 ] && echo "ALL GREEN" || echo "FAILURES"
exit $RC
