// Gabriele bridge — runs on the Mac (where Claude Code lives).
// Owns the agents: spawns `claude` in stream-json mode, tracks each one's
// state, and broadcasts it to any connected overlay over the LAN. Accepts
// prompts back from the overlay (new agent, or follow-up via session resume).

const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.GABRIELE_PORT || 4848);
const CLAUDE = process.env.GABRIELE_CLAUDE || 'claude';

// id -> { id, title, state, lastLine, sessionId, startedAt }
const agents = new Map();
let nextId = 1;

const wss = new WebSocketServer({ host: '0.0.0.0', port: PORT });
console.log(`[gabriele] bridge listening on ws://0.0.0.0:${PORT}`);

function snapshot() {
  return { type: 'agents', agents: [...agents.values()] };
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
function update(agent, patch) {
  Object.assign(agent, patch);
  broadcast({ type: 'agent_update', agent });
}

function firstLine(s, n = 80) {
  if (!s) return '';
  const line = String(s).replace(/\s+/g, ' ').trim();
  return line.length > n ? line.slice(0, n - 1) + '…' : line;
}

// Run one turn for an agent. If agent.sessionId is set, resume that session.
function runTurn(agent, prompt) {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (agent.sessionId) args.push('--resume', agent.sessionId);

  update(agent, { state: 'running', lastLine: firstLine(prompt) });

  const child = spawn(CLAUDE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buf = '';

  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      handleEvent(agent, evt);
    }
  });

  child.on('close', (code) => {
    if (agent.state === 'running') {
      update(agent, code === 0
        ? { state: 'done', lastLine: agent.lastLine || 'done' }
        : { state: 'error', lastLine: `exited ${code}` });
    }
  });
  child.on('error', (err) => update(agent, { state: 'error', lastLine: firstLine(err.message) }));
}

function handleEvent(agent, evt) {
  switch (evt.type) {
    case 'system':
      if (evt.subtype === 'init' && evt.session_id) agent.sessionId = evt.session_id;
      break;
    case 'assistant': {
      const content = evt.message?.content || [];
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim())
          update(agent, { lastLine: firstLine(block.text) });
        else if (block.type === 'tool_use')
          update(agent, { lastLine: `▸ ${block.name}` });
      }
      break;
    }
    case 'result':
      update(agent, {
        state: evt.is_error ? 'error' : 'done',
        lastLine: firstLine(evt.result) || (evt.is_error ? 'error' : 'done'),
        sessionId: evt.session_id || agent.sessionId,
      });
      break;
  }
}

function handlePrompt({ agentId, text, title }) {
  let agent = agentId && agents.get(agentId);
  if (!agent) {
    agent = {
      id: String(nextId++),
      title: title || firstLine(text, 28) || `agent ${nextId}`,
      state: 'running', lastLine: '', sessionId: null, startedAt: Date.now(),
    };
    agents.set(agent.id, agent);
    broadcast({ type: 'agent_update', agent });
  }
  runTurn(agent, text);
  return agent.id;
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify(snapshot()));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'prompt' && msg.text) handlePrompt(msg);
    else if (msg.type === 'clear') {
      for (const [id, a] of agents) if (a.state !== 'running') agents.delete(id);
      broadcast(snapshot());
    }
  });
});
