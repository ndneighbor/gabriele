import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';

// A blocked tool call waiting on you. The agent is paused until you decide.
// Red frame = consequential + needs you now; ALLOW (lime) / DENY (red).
const C = {
  panel: '#141417', line: 'rgba(255,255,255,0.12)', text: '#ececef',
  dim: '#80808a', lime: '#c2ec3a', ink: '#0d0f08', red: '#e8483e', code: '#0a0a0c',
};
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export function ApprovalCard({ approval, onDecide }) {
  return (
    <View style={s.card}>
      <View style={s.top}>
        <Text style={s.agent}>{(approval.agent || 'agent').toUpperCase()} · {(approval.tool || 'TOOL').toUpperCase()}</Text>
        <Text style={s.needs}>APPROVE?</Text>
      </View>
      {!!approval.input && <Text style={s.input} numberOfLines={5}>{approval.input}</Text>}
      <View style={s.row}>
        <TouchableOpacity style={[s.btn, s.deny]} onPress={() => onDecide(approval.id, 'deny')}>
          <Text style={s.denyText}>DENY</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.btn, s.allow]} onPress={() => onDecide(approval.id, 'allow')}>
          <Text style={s.allowText}>ALLOW</Text>
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
  input: { color: C.text, backgroundColor: C.code, borderWidth: 1, borderColor: C.line, padding: 9, fontSize: 12, lineHeight: 17, fontFamily: MONO },
  row: { flexDirection: 'row', gap: 8, marginTop: 10 },
  btn: { flex: 1, paddingVertical: 11, alignItems: 'center' },
  deny: { borderWidth: 1, borderColor: C.red },
  denyText: { color: C.red, fontWeight: '700', letterSpacing: 1.5, fontSize: 12, fontFamily: MONO },
  allow: { backgroundColor: C.lime },
  allowText: { color: C.ink, fontWeight: '700', letterSpacing: 1.5, fontSize: 12, fontFamily: MONO },
});
