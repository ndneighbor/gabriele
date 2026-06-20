import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet,
  StatusBar, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createRelay } from './src/relay';
import { Term } from './src/term';

const C = {
  bg: '#0a0a0c', panel: '#141417', line: 'rgba(255,255,255,0.1)', line2: 'rgba(255,255,255,0.18)',
  text: '#ececef', dim: '#80808a', lime: '#c2ec3a', ink: '#0d0f08', red: '#e8483e', exited: '#5a5a62',
};
const DEFAULT_URL = 'wss://gabriele-relay-production.up.railway.app/ws';
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
  const [connected, setConnected] = useState(false);
  const [hostPresent, setHostPresent] = useState(false);
  const [channels, setChannels] = useState([]);
  const [focusedId, setFocusedId] = useState(null);
  const [prompt, setPrompt] = useState('');

  const relayRef = useRef(null);
  const termRef = useRef(null);
  const termSize = useRef({ cols: 80, rows: 24 });
  const termReady = useRef(false);

  useEffect(() => {
    (async () => {
      const url = (await AsyncStorage.getItem('gab.url')) || '';
      const token = (await AsyncStorage.getItem('gab.token')) || '';
      if (url && token) setCfg({ url, token });
      if (url) setUrlInput(url);
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
      },
    });
    return () => relayRef.current && relayRef.current.disconnect();
  }, [cfg]);

  const onSize = useCallback((cols, rows) => {
    termSize.current = { cols: cols || 80, rows: rows || 24 };
    const r = relayRef.current;
    if (!r) return;
    r.resize(termSize.current.cols, termSize.current.rows); // keep the PTY matched to the phone (fixes garbled wrap)
    if (!termReady.current) { termReady.current = true; if (r.focusedId) r.focus(r.focusedId); } // pull scrollback once
  }, []);

  const sendKey = (seq) => relayRef.current && relayRef.current.input(seq);
  const sendPrompt = () => { if (prompt.trim() && relayRef.current) { relayRef.current.input(prompt + '\r'); setPrompt(''); } };

  function saveAndConnect() {
    const url = urlInput.trim(), token = tokenInput.trim();
    if (!url || !token) return;
    AsyncStorage.setItem('gab.url', url); AsyncStorage.setItem('gab.token', token);
    setCfg({ url, token });
  }
  function forget() {
    AsyncStorage.removeItem('gab.token');
    if (relayRef.current) relayRef.current.disconnect();
    setCfg(null); setConnected(false); setHostPresent(false); setChannels([]); setFocusedId(null);
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
    : [counts.running && `${counts.running} RUN`, counts.idle && `${counts.idle} IDLE`].filter(Boolean).join(' · ') || 'NO CHANNELS';
  const statusColor = (!connected || !hostPresent) ? C.red : C.dim;

  return (
    <View style={s.fill}>
      <StatusBar barStyle="light-content" />
      <View style={s.header}>
        <Text style={s.brand} onPress={forget}>GABRIELE</Text>
        <Text style={[s.status, { color: statusColor }]}>{status}</Text>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.rail} contentContainerStyle={s.railInner}>
        {channels.map((c, i) => {
          const active = c.id === focusedId;
          const dot = c.state === 'running' ? C.lime : c.state === 'idle' ? C.red : C.exited;
          const label = (c.cmd || '').split('/').pop().split(' ')[0] || 'sh';
          return (
            <TouchableOpacity key={c.id}
              onPress={() => { relayRef.current.focus(c.id); relayRef.current.resize(termSize.current.cols, termSize.current.rows); }}
              style={[s.chip, active && s.chipActive]}>
              <View style={[s.dot, { backgroundColor: dot }]} />
              <Text style={[s.chipCh, active && s.chipChActive]}>CH-{i + 1}</Text>
              <Text style={[s.chipLabel, active && s.chipLabelActive]}>{label.toUpperCase()}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity style={[s.chip, s.chipAdd]} onPress={() => relayRef.current.newSession(termSize.current.cols, termSize.current.rows)}>
          <Text style={s.chipAddText}>+</Text>
        </TouchableOpacity>
      </ScrollView>

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

  rail: { flexGrow: 0, borderBottomWidth: 1, borderBottomColor: C.line },
  railInner: { padding: 8, gap: 6 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderColor: C.line, backgroundColor: 'rgba(255,255,255,0.03)' },
  chipActive: { backgroundColor: C.lime, borderColor: C.lime },
  dot: { width: 7, height: 7 },
  chipCh: { color: C.text, fontWeight: '700', letterSpacing: 1, fontSize: 11, fontFamily: MONO },
  chipChActive: { color: C.ink },
  chipLabel: { color: C.dim, letterSpacing: 1, fontSize: 10, fontFamily: MONO },
  chipLabelActive: { color: C.ink },
  chipAdd: { paddingHorizontal: 13 },
  chipAddText: { color: C.dim, fontWeight: '700', fontSize: 16 },

  termWrap: { flex: 1, backgroundColor: C.bg },

  keyRow: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: C.line },
  key: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRightWidth: 1, borderRightColor: C.line },
  keyText: { color: C.dim, fontSize: 12, fontFamily: MONO },
  promptRow: { flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8, borderTopWidth: 1, borderTopColor: C.line },
  prompt: { flex: 1, backgroundColor: C.panel, borderWidth: 1, borderColor: C.line, color: C.text, paddingHorizontal: 12, paddingVertical: 10, fontSize: 13, fontFamily: MONO },
  sendBtn: { backgroundColor: C.lime, paddingHorizontal: 16, paddingVertical: 12 },
  sendText: { color: C.ink, fontWeight: '700', letterSpacing: 1, fontSize: 12 },
});
