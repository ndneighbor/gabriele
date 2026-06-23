import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  StatusBar, KeyboardAvoidingView, Platform, ActivityIndicator, Vibration, Modal,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createRelay } from './src/relay';
import { HandoffCard } from './src/HandoffCard';
import { ApprovalCard } from './src/ApprovalCard';
import { NotificationFeed } from './src/NotificationFeed';
import { Term } from './src/term';

const C = {
  bg: '#0a0a0c', panel: '#141417', line: 'rgba(255,255,255,0.1)', line2: 'rgba(255,255,255,0.18)',
  text: '#ececef', dim: '#80808a', lime: '#c2ec3a', ink: '#0d0f08', red: '#e8483e', exited: '#5a5a62',
};
const DEFAULT_URL = 'wss://gabriele-relay-production.up.railway.app/ws';
const DEFAULT_MCP = 'https://gabriele-mcp-production.up.railway.app'; // handoff bridge (optional)
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const KEYS = [
  { label: 'ESC', seq: '\x1b' }, { label: 'TAB', seq: '\t' }, { label: '^C', seq: '\x03' },
  { label: '↑', seq: '\x1b[A' }, { label: '↓', seq: '\x1b[B' }, { label: '⏎', seq: '\r' },
];

export default function App() {
  const [loaded, setLoaded] = useState(false);
  const [cfg, setCfg] = useState(null);            // {url, token}
  const [urlInput, setUrlInput] = useState(DEFAULT_URL);
  const [tokenInput, setTokenInput] = useState('');
  const [mcpInput, setMcpInput] = useState(DEFAULT_MCP);
  const [connected, setConnected] = useState(false);
  const [hostPresent, setHostPresent] = useState(false);
  const [latency, setLatency] = useState(null);
  const [channels, setChannels] = useState([]);
  const [focusedId, setFocusedId] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [handoffs, setHandoffs] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [notes, setNotes] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [defaultProfile, setDefaultProfile] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [guard, setGuard] = useState(false); // new channels require tool approval

  const relayRef = useRef(null);
  const termRef = useRef(null);
  const termSize = useRef({ cols: 80, rows: 24 });
  const termReady = useRef(false);

  useEffect(() => {
    (async () => {
      const url = (await AsyncStorage.getItem('gab.url')) || '';
      const token = (await AsyncStorage.getItem('gab.token')) || '';
      const mcp = (await AsyncStorage.getItem('gab.mcp')) ?? DEFAULT_MCP;
      if (url && token) setCfg({ url, token, mcp });
      if (url) setUrlInput(url);
      if (mcp) setMcpInput(mcp);
      setGuard((await AsyncStorage.getItem('gab.guard')) === '1');
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    if (!cfg) return;
    relayRef.current = createRelay({
      url: cfg.url, token: cfg.token,
      on: {
        status: (conn, host) => { setConnected(conn); setHostPresent(host); },
        channels: (list, fid) => { setChannels(list); setFocusedId(fid); },
        data: (id, d) => termRef.current && termRef.current.write(d),
        snapshot: (id, d) => termRef.current && termRef.current.reset(d),
        profiles: (list, def) => { setProfiles(list); setDefaultProfile(def); },
        latency: (ms) => setLatency(ms),
      },
    });
    return () => relayRef.current && relayRef.current.disconnect();
  }, [cfg]);

  // Poll the MCP service: handoffs (active, needs you) + the notifications feed
  // (passive, finished turns). Long buzz for a handoff, short tick for a turn.
  useEffect(() => {
    if (!cfg?.mcp) { setHandoffs([]); setApprovals([]); setNotes([]); return; }
    const base = cfg.mcp.replace(/\/+$/, '');
    let alive = true, primedH = false, primedA = false, primedN = false, lastNoteId = 0;
    const seen = new Set(), seenA = new Set();
    async function poll() {
      try {
        const r = await fetch(`${base}/approvals`, { headers: { authorization: `Bearer ${cfg.token}` } });
        if (alive && r.ok) {
          const list = (await r.json()).approvals || [];
          for (const a of list) if (!seenA.has(a.id)) { seenA.add(a.id); if (primedA) Vibration.vibrate([0, 200, 120, 200]); }
          primedA = true;
          if (alive) setApprovals(list);
        }
      } catch {}
      try {
        const r = await fetch(`${base}/handoffs`, { headers: { authorization: `Bearer ${cfg.token}` } });
        if (alive && r.ok) {
          const list = (await r.json()).handoffs || [];
          for (const h of list) if (!seen.has(h.id)) { seen.add(h.id); if (primedH) Vibration.vibrate(400); }
          primedH = true;
          if (alive) setHandoffs(list);
        }
      } catch {}
      try {
        const r = await fetch(`${base}/notifications?since=${lastNoteId}`, { headers: { authorization: `Bearer ${cfg.token}` } });
        if (alive && r.ok) {
          const fresh = (await r.json()).notifications || [];
          if (fresh.length) lastNoteId = Math.max(lastNoteId, ...fresh.map((n) => Number(n.id)));
          if (primedN && fresh.length) {                              // first poll just seeds; later ones show
            Vibration.vibrate(120);
            if (alive) setNotes((prev) => [...[...fresh].reverse(), ...prev].slice(0, 12));
          }
          primedN = true;
        }
      } catch {}
    }
    poll();
    const t = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [cfg]);

  async function replyHandoff(id, text) {
    if (!cfg?.mcp) return;
    setHandoffs((hs) => hs.filter((h) => h.id !== id)); // optimistic remove
    try {
      await fetch(`${cfg.mcp.replace(/\/+$/, '')}/handoffs/${id}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ text }),
      });
    } catch {}
  }

  async function decideApproval(id, decision) {
    if (!cfg?.mcp) return;
    setApprovals((as) => as.filter((a) => a.id !== id)); // optimistic — unblocks the agent
    try {
      await fetch(`${cfg.mcp.replace(/\/+$/, '')}/approvals/${id}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
        body: JSON.stringify({ decision }),
      });
    } catch {}
  }

  const onSize = useCallback((cols, rows, gen) => {
    termSize.current = { cols: cols || 80, rows: rows || 24 };
    const r = relayRef.current;
    if (!r) return;
    r.resize(termSize.current.cols, termSize.current.rows, gen); // keep the PTY matched to the phone — the size IS the garble fix
    if (!termReady.current) { termReady.current = true; if (r.focusedId) r.focus(r.focusedId); } // resize THEN focus, once
  }, []);

  const sendKey = (seq) => relayRef.current && relayRef.current.input(seq);
  const sendPrompt = () => { if (prompt.trim() && relayRef.current) { relayRef.current.input(prompt + '\r'); setPrompt(''); } };
  const addChannel = (profile) => { setPickerOpen(false); relayRef.current && relayRef.current.newSession(termSize.current.cols, termSize.current.rows, profile || defaultProfile, guard); };
  const onPlus = () => (profiles.length > 1 ? setPickerOpen(true) : addChannel(defaultProfile)); // pick a login if there's more than one

  function saveAndConnect() {
    const url = urlInput.trim(), token = tokenInput.trim(), mcp = mcpInput.trim();
    if (!url) return; // token optional — blank = direct LAN (no relay, no auth)
    AsyncStorage.setItem('gab.url', url); AsyncStorage.setItem('gab.token', token); AsyncStorage.setItem('gab.mcp', mcp);
    setCfg({ url, token, mcp });
  }
  function forget() {
    AsyncStorage.removeItem('gab.token');
    if (relayRef.current) relayRef.current.disconnect();
    setCfg(null); setConnected(false); setHostPresent(false); setChannels([]); setFocusedId(null); setHandoffs([]); setApprovals([]); setNotes([]);
  }

  if (!loaded) {
    return <View style={[s.fill, s.center]}><ActivityIndicator color={C.lime} /></View>;
  }

  // ---- connect screen ----
  if (!cfg) {
    return (
      <View style={s.fill}>
        <StatusBar barStyle="light-content" />
        <View style={s.connectWrap}>
          <Text style={s.brand}>GABRIELE</Text>
          <Text style={s.connectHint}>CONNECT TO YOUR RELAY</Text>
          <Text style={s.fieldLabel}>RELAY URL</Text>
          <TextInput style={s.input} value={urlInput} onChangeText={setUrlInput}
            autoCapitalize="none" autoCorrect={false} placeholder="wss://…/ws" placeholderTextColor={C.dim} />
          <Text style={s.fieldLabel}>TOKEN</Text>
          <TextInput style={s.input} value={tokenInput} onChangeText={setTokenInput}
            autoCapitalize="none" autoCorrect={false} secureTextEntry placeholder="shared secret" placeholderTextColor={C.dim} />
          <Text style={s.connectHintSm}>Relay: wss URL + token (works anywhere, ~200ms).{'\n'}Direct LAN: ws://192.168.50.245:4848, leave token blank (~1ms, same wifi only).</Text>
          <Text style={s.fieldLabel}>HANDOFF URL (OPTIONAL)</Text>
          <TextInput style={s.input} value={mcpInput} onChangeText={setMcpInput}
            autoCapitalize="none" autoCorrect={false} placeholder="https://…mcp host" placeholderTextColor={C.dim} />
          <TouchableOpacity style={s.connectBtn} onPress={saveAndConnect}>
            <Text style={s.connectBtnText}>CONNECT</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ---- main screen ----
  const counts = channels.reduce((a, c) => ((a[c.state] = (a[c.state] || 0) + 1), a), {});
  const status = !connected ? 'RELAY OFFLINE' : !hostPresent ? 'BRIDGE OFFLINE'
    : [counts.running && `${counts.running} RUN`, counts.idle && `${counts.idle} IDLE`].filter(Boolean).join(' · ')
      // never claim "NO CHANNELS" while a chip renders: a re-synced channel whose state isn't exactly running/idle still counts
      || (channels.length ? `${channels.length} CH` : 'NO CHANNELS');
  const statusColor = (!connected || !hostPresent) ? C.red : C.dim;

  return (
    <View style={s.fill}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <Text style={s.brand} onPress={forget}>GABRIELE</Text>
        <View style={s.headerRight}>
          <TouchableOpacity onPress={() => setGuard((g) => { const n = !g; AsyncStorage.setItem('gab.guard', n ? '1' : '0'); return n; })}>
            <Text style={[s.guard, guard && s.guardOn]}>{guard ? '◆ GUARD' : '◇ OPEN'}</Text>
          </TouchableOpacity>
          {connected && latency != null && <Text style={[s.lat, latency < 25 && s.latFast]}>{latency}ms</Text>}
          <Text style={[s.status, { color: statusColor }]}>{status}</Text>
        </View>
      </View>

      {approvals.length > 0 && (
        <View style={s.handoffStack}>
          {approvals.map((a) => <ApprovalCard key={a.id} approval={a} onDecide={decideApproval} />)}
        </View>
      )}

      {handoffs.length > 0 && (
        <View style={s.handoffStack}>
          {handoffs.map((h) => <HandoffCard key={h.id} handoff={h} onReply={replyHandoff} />)}
        </View>
      )}

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.rail} contentContainerStyle={s.railInner}>
        {channels.map((c, i) => {
          const active = c.id === focusedId;
          const dot = c.state === 'running' ? C.lime : c.state === 'idle' ? C.red : C.exited;
          const label = (c.cmd || '').split('/').pop().split(' ')[0] || 'sh';
          return (
            <TouchableOpacity key={c.id}
              onPress={() => {
                if (c.id !== focusedId) termRef.current && termRef.current.reset(''); // blank on switch so the old channel + its stale-size frame never linger
                relayRef.current.focus(c.id);                                          // re-focus (also = manual repaint when tapping the active chip)
                relayRef.current.resize(termSize.current.cols, termSize.current.rows);
              }}
              style={[s.chip, active && s.chipActive]}>
              <View style={[s.dot, { backgroundColor: dot }]} />
              <Text style={[s.chipCh, active && s.chipChActive]}>CH-{i + 1}</Text>
              <Text style={[s.chipLabel, active && s.chipLabelActive]}>{label.toUpperCase()}</Text>
              {profiles.length > 1 && !!c.profile && (
                <Text style={[s.chipProfile, active && s.chipLabelActive]}>{String(c.profile).toUpperCase()}</Text>
              )}
              {c.approvals && <Text style={[s.chipGuard, active && s.chipLabelActive]}>◆</Text>}
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={[s.chip, s.chipAdd]} onPress={onPlus}>
          <Text style={s.chipAddText}>+</Text>
        </TouchableOpacity>
      </ScrollView>

      <NotificationFeed notes={notes} onClear={() => setNotes([])} />

      <View style={s.termWrap}><Term ref={termRef} onSize={onSize} /></View>

      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={s.keyRow}>
          {KEYS.map((k) => (
            <TouchableOpacity key={k.label} style={s.key} onPress={() => sendKey(k.seq)}>
              <Text style={s.keyText}>{k.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <View style={s.promptRow}>
          <TextInput style={s.prompt} value={prompt} onChangeText={setPrompt}
            placeholder="prompt this channel…" placeholderTextColor={C.dim}
            autoCapitalize="none" returnKeyType="send" onSubmitEditing={sendPrompt} />
          <TouchableOpacity style={s.sendBtn} onPress={sendPrompt}>
            <Text style={s.sendText}>SEND</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
        <TouchableOpacity style={s.modalBg} activeOpacity={1} onPress={() => setPickerOpen(false)}>
          <View style={s.picker}>
            <Text style={s.pickerTitle}>NEW CHANNEL · PROFILE</Text>
            {profiles.map((p) => (
              <TouchableOpacity key={p.id} style={s.pickerRow} onPress={() => addChannel(p.id)}>
                <Text style={s.pickerLabel}>{p.label}</Text>
                {p.id === defaultProfile && <Text style={s.pickerDefault}>DEFAULT</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  fill: { flex: 1, backgroundColor: C.bg, paddingTop: StatusBar.currentHeight || 0 },
  center: { alignItems: 'center', justifyContent: 'center' },
  brand: { color: C.text, fontWeight: '700', letterSpacing: 3, fontSize: 13, fontFamily: MONO },

  connectWrap: { flex: 1, padding: 24, justifyContent: 'center' },
  connectHint: { color: C.dim, letterSpacing: 2, fontSize: 11, marginTop: 8, marginBottom: 28 },
  fieldLabel: { color: C.dim, letterSpacing: 1.5, fontSize: 10, marginBottom: 6, marginTop: 14 },
  input: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, color: C.text, padding: 12, fontSize: 13, fontFamily: MONO },
  connectBtn: { backgroundColor: C.lime, padding: 14, alignItems: 'center', marginTop: 28 },
  connectBtnText: { color: C.ink, fontWeight: '700', letterSpacing: 2, fontSize: 13 },

  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  status: { letterSpacing: 1.5, fontSize: 11, fontFamily: MONO },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  guard: { color: C.dim, letterSpacing: 1.5, fontSize: 11, fontFamily: MONO },
  guardOn: { color: C.lime },
  lat: { color: C.dim, fontSize: 11, fontFamily: MONO },
  latFast: { color: C.lime },
  connectHintSm: { color: C.dim, fontSize: 11, lineHeight: 16, marginTop: 8, fontFamily: MONO },
  chipGuard: { color: C.lime, fontSize: 11, paddingLeft: 6 },

  handoffStack: { padding: 8, paddingBottom: 0 },

  rail: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: C.line },
  railInner: { padding: 8, gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.03)' },
  chipActive: { backgroundColor: C.lime, borderColor: C.lime },
  dot: { width: 7, height: 7 },
  chipCh: { color: C.text, fontWeight: '700', letterSpacing: 1, fontSize: 11, fontFamily: MONO },
  chipChActive: { color: C.ink },
  chipLabel: { color: C.dim, letterSpacing: 1, fontSize: 10, fontFamily: MONO },
  chipLabelActive: { color: C.ink },
  chipProfile: { color: C.lime, letterSpacing: 1, fontSize: 9, fontFamily: MONO, borderLeftWidth: 1, borderLeftColor: C.line2, paddingLeft: 7 },
  chipAdd: { paddingHorizontal: 13 },
  chipAddText: { color: C.dim, fontWeight: '700', fontSize: 16 },

  modalBg: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 28 },
  picker: { backgroundColor: C.panel, borderWidth: 1, borderColor: C.line2 },
  pickerTitle: { color: C.dim, letterSpacing: 2, fontSize: 11, fontFamily: MONO, padding: 14, borderBottomWidth: 1, borderBottomColor: C.line },
  pickerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: C.line },
  pickerLabel: { color: C.text, fontSize: 14, fontFamily: MONO },
  pickerDefault: { color: C.lime, letterSpacing: 1.5, fontSize: 9, fontFamily: MONO },

  termWrap: { flex: 1, backgroundColor: C.bg },

  keyRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line },
  key: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRightWidth: 1, borderRightColor: C.line },
  keyText: { color: C.dim, fontSize: 12, fontFamily: MONO },
  promptRow: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8, borderTopWidth: 1, borderTopColor: C.line },
  prompt: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, color: C.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, fontFamily: MONO },
  sendBtn: { backgroundColor: C.lime, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: C.ink, fontWeight: '700', letterSpacing: 1, fontSize: 12 },
});
