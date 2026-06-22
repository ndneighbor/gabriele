import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';

// Passive feed of finished agent turns (from the Stop hook → /notify). Lime =
// informational (vs the red handoff card = needs you). Compact + capped height
// so it never crowds the terminal; CLEAR wipes it.
const C = { panel: '#141417', line: 'rgba(255,255,255,0.1)', text: '#ececef', dim: '#80808a', lime: '#c2ec3a' };
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

export function NotificationFeed({ notes, onClear }) {
  if (!notes || !notes.length) return null;
  return (
    <View style={s.wrap}>
      <View style={s.head}>
        <Text style={s.headText}>FEED · {notes.length}</Text>
        <TouchableOpacity onPress={onClear}><Text style={s.clear}>CLEAR</Text></TouchableOpacity>
      </View>
      <ScrollView style={s.list} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {notes.map((n) => (
          <View key={n.id} style={s.row}>
            <Text style={s.agent}>{(n.agent || 'agent').toUpperCase()}</Text>
            <Text style={s.text} numberOfLines={2}>{n.text}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { borderBottomWidth: 1, borderBottomColor: C.line },
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4 },
  headText: { color: C.dim, letterSpacing: 2, fontSize: 9, fontFamily: MONO },
  clear: { color: C.dim, letterSpacing: 1.5, fontSize: 9, fontFamily: MONO },
  list: { maxHeight: 116 },
  row: { paddingHorizontal: 12, paddingVertical: 7, borderTopWidth: 1, borderTopColor: C.line, flexDirection: 'row', gap: 8 },
  agent: { color: C.lime, letterSpacing: 1, fontSize: 10, fontFamily: MONO, paddingTop: 1, minWidth: 64 },
  text: { color: C.text, fontSize: 12, lineHeight: 16, fontFamily: MONO, flex: 1 },
});
