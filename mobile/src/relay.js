// Gabriele relay client — same protocol as the desktop overlay, just another
// client of the relay. Pure JS (uses the global WebSocket), so it runs in React
// Native and can be unit-tested in Node against the live relay.

export function createRelay({ url, token, on = {} }) {
  const clientId = `mobile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const clientKind = 'mobile';
  let ws;
  let ready = false;
  let focusedId = null;
  let sessions = new Map(); // id -> meta
  let profiles = [];        // [{id,label}] advertised by the bridge
  let defaultProfile = null;
  const direct = !token;    // no token => talk straight to the bridge's LAN server (no relay, no detour)
  let pingTimer = null;
  let wasDown = false;      // set on a real socket drop, so we repaint only on genuine reconnect (not every sessions frame)

  const ordered = () => [...sessions.values()].sort((a, b) => a.startedAt - b.startedAt);
  const emitChannels = () => on.channels && on.channels(ordered(), focusedId);

  function send(obj) {
    if (ready && ws && ws.readyState === 1) ws.send(JSON.stringify({ clientId, clientKind, ...obj }));
  }

  function startProbe() {   // live RTT readout: ping every 2s, pong measures the link
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (ws && ws.readyState === 1) send({ type: 'ping', t: Date.now() }); }, 2000);
  }

  function connect() {
    ready = false;
    try {
      ws = new WebSocket(url);
    } catch {
      on.status && on.status(false, false);
      setTimeout(connect, 1500);
      return;
    }
    ws.onopen = () => {
      if (direct) { ready = true; on.status && on.status(true, true); send({ type: 'client_hello' }); send({ type: 'sync' }); startProbe(); } // LAN: the bridge is right here
      else ws.send(JSON.stringify({ type: 'hello', role: 'client', token }));
    };
    ws.onclose = () => { ready = false; wasDown = true; clearInterval(pingTimer); on.status && on.status(false, false); setTimeout(connect, 1500); };
    ws.onerror = () => { try { ws.close(); } catch {} };
    ws.onmessage = (e) => handle(JSON.parse(e.data));
  }

  function handle(m) {
    switch (m.type) {
      case 'hello_ok':
        ready = true;
        on.status && on.status(true, m.host_present !== false);
        send({ type: 'client_hello' });
        send({ type: 'sync' });
        startProbe();
        break;
      case 'pong':
        on.latency && on.latency(Date.now() - m.t);
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
        if (m.profiles) {
          profiles = m.profiles;
          defaultProfile = m.defaultProfile || (m.profiles[0] && m.profiles[0].id) || null;
          on.profiles && on.profiles(profiles, defaultProfile);
        }
        emitChannels();
        // Repaint ONLY after a genuine reconnect (wasDown), not on every sessions frame —
        // otherwise a flapping link triggers a reset storm mid-stream (the garble).
        if (focusedId && sessions.has(focusedId)) { if (wasDown) focus(focusedId); }
        else if (m.sessions[0]) focus(m.sessions[0].id);
        wasDown = false;
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
  function resize(cols, rows, gen) { if (focusedId) send({ type: 'resize', id: focusedId, cols, rows, gen }); }
  function newSession(cols = 80, rows = 24, profile, approvals) { send({ type: 'new', cols, rows, profile, approvals }); }
  function close(id) { send({ type: 'close', id }); }

  connect();
  return {
    focus, input, resize, newSession, close, send, ordered,
    get focusedId() { return focusedId; },
    get profiles() { return profiles; },
    get defaultProfile() { return defaultProfile; },
    disconnect() { clearInterval(pingTimer); try { ws && ws.close(); } catch {} },
  };
}
