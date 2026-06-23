// Gabriele ADB MCP server.
//
// Exposes a small, explicit set of Android emulator/device controls to MCP
// clients: inspect devices, tap/type/keyevent, screenshots, logcat, adb reverse,
// and Expo reload/open helpers.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const PORT = Number(process.env.PORT || process.env.GABRIELE_ADB_MCP_PORT || 8182);
const TOKEN = process.env.GABRIELE_TOKEN || process.env.GABRIELE_RELAY_SECRET || 'dev-secret';
const ADB = process.env.ADB || 'adb';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 80_000;

function runAdb(args, { timeoutMs = DEFAULT_TIMEOUT_MS, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ADB, args, { encoding });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\nadb timed out after ${timeoutMs}ms`.trim() });
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString(encoding).slice(0, MAX_OUTPUT - stdout.length); });
    child.stderr.on('data', (d) => { stderr += d.toString(encoding).slice(0, MAX_OUTPUT - stderr.length); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });
}

function serialArgs(serial) {
  return serial ? ['-s', serial] : [];
}

function textResult(result) {
  const text = [
    result.stdout && result.stdout.trimEnd(),
    result.stderr && result.stderr.trimEnd(),
  ].filter(Boolean).join('\n');
  return {
    content: [{ type: 'text', text: text || (result.ok ? 'ok' : `adb exited ${result.code}`) }],
    isError: !result.ok,
  };
}

function buildServer() {
  const server = new McpServer(
    { name: 'gabriele-adb', version: '0.1.0' },
    { instructions: 'Control Android devices attached through adb for Gabriele testing. Prefer targeted tools over raw shell.' },
  );

  server.registerTool('devices', {
    title: 'List ADB devices',
    description: 'Run `adb devices -l`.',
    inputSchema: {},
  }, async () => textResult(await runAdb(['devices', '-l'])));

  server.registerTool('restart_server', {
    title: 'Restart ADB server',
    description: 'Run `adb kill-server`, `adb start-server`, then list devices.',
    inputSchema: {},
  }, async () => {
    await runAdb(['kill-server']);
    const started = await runAdb(['start-server']);
    const devices = await runAdb(['devices', '-l']);
    return textResult({
      ok: started.ok && devices.ok,
      code: started.ok && devices.ok ? 0 : 1,
      stdout: `${started.stdout}${devices.stdout}`,
      stderr: `${started.stderr}${devices.stderr}`,
    });
  });

  server.registerTool('screenshot', {
    title: 'Take screenshot',
    description: 'Take a PNG screenshot and return it as base64 text.',
    inputSchema: { serial: z.string().optional() },
  }, async ({ serial }) => {
    const result = await runAdb([...serialArgs(serial), 'exec-out', 'screencap', '-p'], { encoding: 'latin1' });
    if (!result.ok) return textResult(result);
    const base64 = Buffer.from(result.stdout, 'latin1').toString('base64');
    return { content: [{ type: 'text', text: base64 }] };
  });

  server.registerTool('tap', {
    title: 'Tap screen',
    description: 'Tap screen coordinates.',
    inputSchema: {
      x: z.number().int(),
      y: z.number().int(),
      serial: z.string().optional(),
    },
  }, async ({ serial, x, y }) => textResult(await runAdb([...serialArgs(serial), 'shell', 'input', 'tap', String(x), String(y)])));

  server.registerTool('text', {
    title: 'Type text',
    description: 'Type text with `adb shell input text`.',
    inputSchema: {
      text: z.string(),
      serial: z.string().optional(),
    },
  }, async ({ serial, text }) => {
    const escaped = text.replace(/%/g, '%s').replace(/\s/g, '%s');
    return textResult(await runAdb([...serialArgs(serial), 'shell', 'input', 'text', escaped]));
  });

  server.registerTool('keyevent', {
    title: 'Send keyevent',
    description: 'Send an Android keyevent, such as BACK, MENU, ENTER, or 82.',
    inputSchema: {
      key: z.union([z.string(), z.number().int()]),
      serial: z.string().optional(),
    },
  }, async ({ serial, key }) => textResult(await runAdb([...serialArgs(serial), 'shell', 'input', 'keyevent', String(key)])));

  server.registerTool('reverse', {
    title: 'ADB reverse',
    description: 'Map a device TCP port to a host TCP port.',
    inputSchema: {
      devicePort: z.number().int().default(8081),
      hostPort: z.number().int().default(8081),
      serial: z.string().optional(),
    },
  }, async ({ serial, devicePort, hostPort }) => {
    const result = await runAdb([...serialArgs(serial), 'reverse', `tcp:${devicePort}`, `tcp:${hostPort}`]);
    const list = await runAdb([...serialArgs(serial), 'reverse', '--list']);
    return textResult({
      ok: result.ok && list.ok,
      code: result.ok && list.ok ? 0 : 1,
      stdout: `${result.stdout}${list.stdout}`,
      stderr: `${result.stderr}${list.stderr}`,
    });
  });

  server.registerTool('open_expo', {
    title: 'Open Expo URL',
    description: 'Open an Expo project URL in Expo Go.',
    inputSchema: {
      url: z.string().default('exp://127.0.0.1:8081'),
      serial: z.string().optional(),
    },
  }, async ({ serial, url }) => textResult(await runAdb([...serialArgs(serial), 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, 'host.exp.exponent'])));

  server.registerTool('reload_expo', {
    title: 'Reload Expo app',
    description: 'Restore Metro reverse, open the Expo URL, and send KEYCODE_R twice.',
    inputSchema: {
      url: z.string().default('exp://127.0.0.1:8081'),
      serial: z.string().optional(),
    },
  }, async ({ serial, url }) => {
    const prefix = serialArgs(serial);
    const reverse = await runAdb([...prefix, 'reverse', 'tcp:8081', 'tcp:8081']);
    const open = await runAdb([...prefix, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url, 'host.exp.exponent']);
    await new Promise((r) => setTimeout(r, 500));
    const r1 = await runAdb([...prefix, 'shell', 'input', 'keyevent', 'KEYCODE_R']);
    const r2 = await runAdb([...prefix, 'shell', 'input', 'keyevent', 'KEYCODE_R']);
    return textResult({
      ok: reverse.ok && open.ok && r1.ok && r2.ok,
      code: reverse.ok && open.ok && r1.ok && r2.ok ? 0 : 1,
      stdout: `${reverse.stdout}${open.stdout}${r1.stdout}${r2.stdout}`,
      stderr: `${reverse.stderr}${open.stderr}${r1.stderr}${r2.stderr}`,
    });
  });

  server.registerTool('logcat', {
    title: 'Read logcat',
    description: 'Read recent logcat lines. Use a small line count.',
    inputSchema: {
      lines: z.number().int().min(1).max(1000).default(200),
      serial: z.string().optional(),
      filter: z.string().optional(),
    },
  }, async ({ serial, lines, filter }) => {
    const result = await runAdb([...serialArgs(serial), 'logcat', '-d', '-t', String(lines)], { timeoutMs: 20_000 });
    if (!result.ok || !filter) return textResult(result);
    return textResult({ ...result, stdout: result.stdout.split('\n').filter((line) => line.includes(filter)).join('\n') });
  });

  server.registerTool('shell', {
    title: 'ADB shell',
    description: 'Run a simple adb shell command. Avoid destructive commands.',
    inputSchema: {
      command: z.string(),
      serial: z.string().optional(),
    },
  }, async ({ serial, command }) => textResult(await runAdb([...serialArgs(serial), 'shell', command], { timeoutMs: 20_000 })));

  return server;
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7)
    : (req.params.token || req.headers['x-gabriele-token'] || '');
  if (tok !== TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

const transports = {};

async function mcpPost(req, res) {
  const sid = req.headers['mcp-session-id'];
  let transport = sid ? transports[sid] : undefined;
  if (!transport) {
    if (sid || !isInitializeRequest(req.body)) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'No valid session ID' }, id: null });
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
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

app.get('/healthz', (_req, res) => res.json({ ok: true, server: 'gabriele-adb' }));
app.post(['/mcp', '/mcp/:token'], auth, mcpPost);
app.get(['/mcp', '/mcp/:token'], auth, sessionReq);
app.delete(['/mcp', '/mcp/:token'], auth, sessionReq);

app.listen(PORT, () => console.log(`[gabriele-adb-mcp] listening on :${PORT} (token ${TOKEN === 'dev-secret' ? 'DEV' : 'set'})`));
