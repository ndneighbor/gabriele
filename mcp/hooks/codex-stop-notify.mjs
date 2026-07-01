#!/usr/bin/env node
// Codex Stop hook -> notify the local Gabriele bridge that this turn completed.
// It is intentionally silent outside bridge-spawned sessions.

const URL = process.env.GABRIELE_NOTIFY_URL || '';
const TOKEN = process.env.GABRIELE_NOTIFY_TOKEN || '';
const ID = process.env.GABRIELE_SESSION_ID || '';
const AGENT = process.env.GABRIELE_AGENT_KIND || 'codex';

const done = () => process.exit(0);
if (!URL || !TOKEN || !ID) done();

function readStdin() {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.length > 64 * 1024) {
        input = input.slice(0, 64 * 1024);
        process.stdin.destroy();
      }
    });
    process.stdin.on('end', () => resolve(input));
    process.stdin.on('error', () => resolve(input));
  });
}

function parseJson(text) {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
}

function messageFrom(payload, cwd) {
  const direct = payload.summary || payload.message || payload.text || payload.output || payload.last_response;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  return cwd ? `Turn complete in ${cwd.split('/').pop()}` : 'Turn complete';
}

const timeout = setTimeout(done, 5000);
try {
  const payload = parseJson(await readStdin());
  const cwd = payload.cwd || process.env.PWD || process.cwd();
  await fetch(URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      id: ID,
      sessionId: payload.session_id || payload.sessionId || null,
      agent: AGENT,
      title: `${AGENT === 'codex' ? 'Codex' : AGENT} completed`,
      body: messageFrom(payload, cwd).slice(0, 240),
      cwd,
      source: 'codex-stop-hook',
    }),
    signal: AbortSignal.timeout(4500),
  });
} catch {}
clearTimeout(timeout);
done();
