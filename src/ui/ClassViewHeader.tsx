import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { ThemePalette } from './theme';

export function ClassViewHeader(props: {
  name: string;
  onBack(): void;
  onRename(name: string): void;
  palette: ThemePalette;
}) {
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.name);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== props.name) props.onRename(trimmed);
    else setDraft(props.name);
  };

  return (
    <View style={styles.header}>
      <Pressable testID="class-back" accessibilityRole="button" accessibilityLabel="Назад" onPress={props.onBack} hitSlop={12} style={styles.backButton}>
        <Text style={styles.backArrow}>←</Text>
      </Pressable>
      {editing ? (
        <TextInput
          testID="class-name-input"
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onBlur={commit}
          autoFocus
          style={styles.nameInput}
        />
      ) : (
        <Pressable testID="class-name-label" onPress={() => { setDraft(props.name); setEditing(true); }}>
          <Text style={styles.name}>{props.name}</Text>
        </Pressable>
      )}
    </View>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 24, paddingBottom: 18, gap: 14 },
    backButton: { width: 40, height: 40, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accentSoft },
    backArrow: { color: p.accent, fontSize: 20, fontWeight: '900' },
    name: { color: p.text, fontSize: 28, fontWeight: '900' },
    nameInput: { color: p.text, fontSize: 28, fontWeight: '900', flex: 1, padding: 0, borderBottomWidth: 2, borderBottomColor: p.accent },
  });
}
