// Verify the bridge wires each channel's CLAUDE_CONFIG_DIR from its profile.
// Spawns /bin/sh channels (not claude) that just echo the env, so we can assert
// the login dir without needing a real claude login.
import { WebSocket } from 'ws';
import os from 'node:os';

const URL = process.env.BRIDGE || 'ws://localhost:4848';
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`) || (c || process.exit(1));
const ws = new WebSocket(URL);
const out = new Map(); // sessionId -> accumulated data
let profilesMsg = null;

const send = (o) => ws.send(JSON.stringify(o));
function newSh(profile, marker) {
  send({ type: 'new', cmd: '/bin/sh', args: ['-c', `printf '${marker}=[%s]\\n' "$CLAUDE_CONFIG_DIR"; sleep 0.3`], profile });
}

ws.on('open', () => {
  send({ type: 'sync' });
  newSh('personal', 'PERSONAL');
  newSh('work', 'WORK');
});

ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.type === 'sessions' && m.profiles) profilesMsg = m;
  if (m.type === 'data') out.set(m.id, (out.get(m.id) || '') + m.data);
});

setTimeout(() => {
  const all = [...out.values()].join('');
  ok(!!profilesMsg, `bridge advertises profiles (${profilesMsg?.profiles?.map((p) => p.id).join(', ')}), default=${profilesMsg?.defaultProfile}`);
  ok(all.includes(`PERSONAL=[${os.homedir()}/.claude-personal]`), `personal channel → CLAUDE_CONFIG_DIR=~/.claude-personal`);
  ok(/WORK=\[\]/.test(all), 'work channel → CLAUDE_CONFIG_DIR unset (default ~/.claude)');
  console.log('\nALL GREEN');
  process.exit(0);
}, 1500);
