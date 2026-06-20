// Gabriele relay client — same protocol as the desktop overlay, just another
// client of the relay. Pure JS (uses the global WebSocket), so it runs in React
// Native and can be unit-tested in Node against the live relay.

export function createRelay({ url, token, on = {} }) {
  let ws;
  let ready = false;
  let focusedId = null;
  let sessions = new Map(); // id -> meta

  const ordered = () => [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  const emitChannels = () => on.channels && on.channels(ordered(), focusedId);

  function send(obj) {
    if (ready && ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  function connect() {
    ready = false;
    ws = new WebSocket(url);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', role: 'client', token }));
    ws.onclose = () => { ready = false; on.status && on.status(false, false); setTimeout(connect, 1500); };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
  }

  function handle(m) {
    switch (m.type) {
      case 'hello_ok':
        ready = true;
        on.status && on.status(true, m.host_present !== false);
        send({ type: 'sync' });
        break;
      case 'host_up':
        on.status && on.status(true, true);
        send({ type: 'sync' });
        break;
      case 'host_down':
        on.status && on.status(true, false);
        break;
      case 'sessions':
        sessions = new Map(m.sessions.map((s) => [s.id, s]));
        if (!focusedId && m.sessions[0]) focus(m.sessions[0].id);
        emitChannels();
        break;
      case 'session': {
        const prev = sessions.get(m.meta.id);
        sessions.set(m.meta.id, m.meta);
        if (!focusedId) focus(m.meta.id);
        emitChannels();
        on.transition && on.transition(prev, m.meta);
        break;
      }
      case 'data':
        if (m.id === focusedId) on.data && on.data(m.id, m.data);
        break;
      case 'snapshot':
        if (m.id === focusedId) on.snapshot && on.snapshot(m.id, m.data);
        break;
      case 'closed':
        sessions.delete(m.id);
        if (focusedId === m.id) { focusedId = null; const n = [...sessions.keys()][0]; if (n) focus(n); }
        emitChannels();
        break;
    }
  }

  function focus(id) { focusedId = id; send({ type: 'focus', id }); emitChannels(); }
  function input(data) { if (focusedId) send({ type: 'input', id: focusedId, data }); }
  function resize(cols, rows) { if (focusedId) send({ type: 'resize', id: focusedId, cols, rows }); }
  function newSession(cols = 80, rows = 24) { send({ type: 'new', cols, rows }); }
  function close(id) { send({ type: 'close', id }); }

  connect();
  return {
    focus, input, resize, newSession, close, send, ordered,
    get focusedId() { return focusedId; },
    disconnect() { try { ws && ws.close(); } catch {} },
  };
}
