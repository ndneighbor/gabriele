// Gabriele handoff MCP server — agent-agnostic.
//
// Any MCP-speaking agent (Claude Code, Codex, Cursor, …) registers this server
// and calls the `handoff` tool. The tool posts the agent's status/question to a
// pending queue and BLOCKS until the human operator replies (from the phone,
// which polls the REST API below). The operator's reply becomes the tool's
// return value, so the agent reads it as if it were a normal tool result.
//
// MCP is Claude-pull (the agent calls tools); we invert that into push by
// holding the tool call open until a human answers. No relay, no PTY — works on
// any session, including a Claude Desktop one we can't otherwise reach.
//
//   agent  --calls handoff(summary,question)-->  [pending queue]  <--polls/replies--  phone
//             <-------- operator's reply (tool result) --------

import express from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || 8181);
const TOKEN = process.env.GABRIELE_TOKEN || process.env.GABRIELE_RELAY_SECRET || 'dev-secret';
// How long a handoff blocks waiting for the operator. Kept under common proxy/
// client request timeouts; on expiry the agent is told to use its judgment.
const HANDOFF_TIMEOUT_MS = Number(process.env.GABRIELE_HANDOFF_TIMEOUT_MS || 4 * 60 * 1000);

// ---- pending handoffs: the bridge between any MCP agent and the operator ----
const pending = new Map(); // id -> { id, agent, summary, question, choices, createdAt, resolve }

function postHandoff({ agent, summary, question, choices }) {
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (pending.delete(id)) resolve(null); }, HANDOFF_TIMEOUT_MS);
    pending.set(id, {
      id, agent, summary, question, choices: choices || [], createdAt: Date.now(),
      resolve: (text) => { clearTimeout(timer); pending.delete(id); resolve(text); },
    });
  });
}

function buildServer() {
  const server = new McpServer(
    { name: 'gabriele', version: '0.1.0' },
    { instructions: 'Gabriele bridges you to your human operator. Call `handoff` to report status / ask a question and block for their reply — whenever you finish a step, hit a decision, or need input.' },
  );

  server.registerTool('handoff', {
    title: 'Hand off to operator',
    description:
      'Report your current status or a decision point to the human operator (shown on their phone) and BLOCK until they reply. ' +
      'Use this when you finish a step, reach a fork in the road, need a decision, or are blocked on human input. ' +
      "The return value is the operator's instruction — follow it. If it times out, use your best judgment and proceed.",
    inputSchema: {
      summary: z.string().describe('Short status: what you just did or where you are.'),
      question: z.string().optional().describe('The specific question or decision you need answered, if any.'),
      choices: z.array(z.string()).optional().describe('Optional suggested replies the operator can one-tap.'),
    },
  }, async ({ summary, question, choices }) => {
    const ci = server.server.getClientVersion?.();           // who is asking (from MCP clientInfo)
    const agent = (ci && ci.name) || 'agent';
    const reply = await postHandoff({ agent, summary, question, choices });
    const text = reply == null
      ? '(No operator reply within the timeout — proceed using your best judgment.)'
      : reply;
    return { content: [{ type: 'text', text }] };
  });

  return server;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  // token from: Authorization header (CLI --header) | URL path :token (OAuth-only
  // connector UIs that can't send a custom header, e.g. Claude Desktop) | x- header
  const tok = h.startsWith('Bearer ') ? h.slice(7)
    : (req.params.token || req.headers['x-gabriele-token'] || '');
  if (tok !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true, pending: pending.size }));

// ---- MCP endpoint: stateful Streamable HTTP (session per initialize) ----
const transports = {}; // sessionId -> transport

// Mounted on BOTH /mcp (token via Authorization header → `claude mcp add --header`)
// and /mcp/:token (token in the URL → OAuth-only connector UIs like Claude Desktop).
async function mcpPost(req, res) {
  const sid = req.headers['mcp-session-id'];
  let transport = sid ? transports[sid] : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID' }, id: null });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,                               // plain JSON responses (simple clients + curl)
      onsessioninitialized: (id) => { transports[id] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
    await buildServer().connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
}

async function sessionReq(req, res) {
  const sid = req.headers['mcp-session-id'];
  const transport = sid ? transports[sid] : undefined;
  if (!transport) return res.status(400).send('Invalid or missing session ID');
  await transport.handleRequest(req, res);
}

app.post(['/mcp', '/mcp/:token'], auth, mcpPost);
app.get(['/mcp', '/mcp/:token'], auth, sessionReq);     // server->client SSE stream
app.delete(['/mcp', '/mcp/:token'], auth, sessionReq);  // session teardown

// ---- operator REST API (the phone polls this) ----
app.get('/handoffs', auth, (_req, res) => {
  res.json({ handoffs: [...pending.values()].map(({ resolve, ...h }) => h) });
});
app.post('/handoffs/:id/reply', auth, (req, res) => {
  const h = pending.get(req.params.id);
  if (!h) return res.status(404).json({ error: 'no such pending handoff' });
  const text = ((req.body && req.body.text) || '').toString();
  if (!text.trim()) return res.status(400).json({ error: 'empty reply' });
  h.resolve(text);
  res.json({ ok: true });
});

// ---- notifications: passive feed. A Claude Code Stop hook POSTs every agent
// response here (non-blocking), so the phone sees turns finish on ANY session. ----
const NOTES_CAP = 50;
const notifications = []; // [{ id, agent, text, cwd, at }]
let noteSeq = 1;
app.post('/notify', auth, (req, res) => {
  const b = req.body || {};
  const text = (b.text || '').toString().trim();
  if (!text) return res.status(400).json({ error: 'empty text' });
  const note = { id: String(noteSeq++), agent: (b.agent || 'agent').toString().slice(0, 60), text: text.slice(0, 4000), cwd: (b.cwd || '').toString(), at: Date.now() };
  notifications.push(note);
  if (notifications.length > NOTES_CAP) notifications.shift();
  res.json({ ok: true, id: note.id });
});
app.get('/notifications', auth, (req, res) => {
  const since = Number(req.query.since || 0);
  const list = since ? notifications.filter((n) => Number(n.id) > since) : notifications.slice(-20);
  res.json({ notifications: list });
});

app.listen(PORT, () => console.log(`[gabriele-mcp] listening on :${PORT} (token ${TOKEN === 'dev-secret' ? 'DEV' : 'set'})`));
