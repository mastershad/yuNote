import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Class } from '../data/classes';
import type { ThemePalette } from './theme';

function pluralizeNotes(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} заметка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${count} заметки`;
  return `${count} заметок`;
}

export function ClassCard(props: {
  klass: Class;
  noteCount: number;
  onPress(): void;
  palette: ThemePalette;
  hovered?: boolean;
}) {
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);
  return (
    <Pressable
      testID={`class-${props.klass.id}`}
      onPress={props.onPress}
      style={({ pressed }) => [styles.card, props.hovered && styles.hovered, pressed && styles.pressed]}>
      <View style={styles.stackBack2} />
      <View style={styles.stackBack1} />
      <View style={styles.cardAccent} />
      <View style={styles.cardContent}>
        <Text numberOfLines={1} style={styles.cardTitle}>{props.klass.name}</Text>
        <Text style={styles.cardBody}>{pluralizeNotes(props.noteCount)}</Text>
      </View>
    </Pressable>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    card: { minHeight: 132, flexDirection: 'row', overflow: 'hidden', borderRadius: 24, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, elevation: 2, shadowColor: '#000', shadowOpacity: p.mode === 'dark' ? 0.18 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
    stackBack1: { position: 'absolute', top: -4, left: 10, right: 10, height: 12, borderRadius: 16, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, opacity: 0.9 },
    stackBack2: { position: 'absolute', top: -8, left: 22, right: 22, height: 10, borderRadius: 16, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border, opacity: 0.6 },
    cardAccent: { width: 6, backgroundColor: p.accentSecondary },
    cardContent: { flex: 1, paddingHorizontal: 18, paddingVertical: 16 },
    cardTitle: { color: p.text, fontSize: 19, fontWeight: '900' },
    cardBody: { color: p.mutedText, fontSize: 15, lineHeight: 21, marginTop: 7 },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
    // Spec §7's hover-over-valid-target reaction: a dragged note currently
    // over this class card scales up slightly and tints toward the accent,
    // signaling "drop here" without a new visual language.
    hovered: { transform: [{ scale: 1.04 }], backgroundColor: p.accentSoft },
  });
}
