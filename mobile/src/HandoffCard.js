import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform } from 'react-native';

// A pending agent → operator handoff. Red-framed (the "needs you" signal),
// shows which agent asked, its status + question, one-tap suggested replies,
// and a free-text reply. Acting on it POSTs to the MCP server, unblocking the
// agent's handoff() tool call.
const C = {
  panel: '#141417', line: 'rgba(255,255,255,0.12)', text: '#ececef',
  dim: '#80808a', lime: '#c2ec3a', ink: '#0d0f08', red: '#e8483e',
};
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export function HandoffCard({ handoff, onReply }) {
  const [text, setText] = useState('');
  const send = (t) => { const v = (t ?? text).trim(); if (v) onReply(handoff.id, v); setText(''); };
  const choices = Array.isArray(handoff.choices) ? handoff.choices : [];

  return (
    <View style={s.card}>
      <View style={s.top}>
        <Text style={s.agent}>{(handoff.agent || 'AGENT').toUpperCase()}</Text>
        <Text style={s.needs}>NEEDS YOU</Text>
      </View>
      <Text style={s.summary}>{handoff.summary}</Text>
      {!!handoff.question && <Text style={s.question}>{handoff.question}</Text>}
      {choices.length > 0 && (
        <View style={s.choices}>
          {choices.map((c) => (
            <TouchableOpacity key={c} style={s.choice} onPress={() => send(c)}>
              <Text style={s.choiceText}>{c}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
      <View style={s.replyRow}>
        <TextInput style={s.input} value={text} onChangeText={setText}
          placeholder="reply…" placeholderTextColor={C.dim} autoCapitalize="none"
          returnKeyType="send" onSubmitEditing={() => send()} />
        <TouchableOpacity style={s.send} onPress={() => send()}>
          <Text style={s.sendText}>SEND</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  card: { borderWidth: 1, borderColor: C.red, backgroundColor: C.panel, padding: 12, marginBottom: 8 },
  top: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  agent: { color: C.text, fontWeight: '700', letterSpacing: 1.5, fontSize: 11, fontFamily: MONO },
  needs: { color: C.red, fontWeight: '700', letterSpacing: 2, fontSize: 10, fontFamily: MONO },
  summary: { color: C.text, fontSize: 13, lineHeight: 18, fontFamily: MONO },
  question: { color: C.lime, fontSize: 13, lineHeight: 18, marginTop: 6, fontFamily: MONO },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  choice: { borderWidth: 1, borderColor: C.lime, paddingHorizontal: 14, paddingVertical: 8 },
  choiceText: { color: C.lime, fontWeight: '700', letterSpacing: 1, fontSize: 12, fontFamily: MONO },
  replyRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  input: { flex: 1, backgroundColor: '#0a0a0c', borderWidth: 1, borderColor: C.line, color: C.text, paddingHorizontal: 12, paddingVertical: 9, fontSize: 13, fontFamily: MONO },
  send: { backgroundColor: C.lime, paddingHorizontal: 16, justifyContent: 'center' },
  sendText: { color: C.ink, fontWeight: '700', letterSpacing: 1, fontSize: 12, fontFamily: MONO },
});
