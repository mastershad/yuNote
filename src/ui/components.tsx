import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { ThemePalette } from './theme';

export function ScreenHeader(props: {
  eyebrow: string;
  title: string;
  subtitle: string;
  palette: ThemePalette;
}) {
  const styles = makeStyles(props.palette);
  return (
    <View style={styles.header}>
      <Text style={styles.eyebrow}>{props.eyebrow}</Text>
      <Text style={styles.title}>{props.title}</Text>
      <Text style={styles.subtitle}>{props.subtitle}</Text>
    </View>
  );
}

export function EmptyState(props: {
  symbol: string;
  title: string;
  body: string;
  palette: ThemePalette;
}) {
  const styles = makeStyles(props.palette);
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}><Text style={styles.emptySymbol}>{props.symbol}</Text></View>
      <Text style={styles.emptyTitle}>{props.title}</Text>
      <Text style={styles.emptyBody}>{props.body}</Text>
    </View>
  );
}

export function FloatingAddButton(props: {
  testID: string;
  label: string;
  onPress(): void;
  palette: ThemePalette;
}) {
  const styles = makeStyles(props.palette);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      testID={props.testID}
      onPress={props.onPress}
      style={({ pressed }) => [styles.fab, pressed && styles.pressed]}>
      <Text style={styles.fabPlus}>＋</Text>
    </Pressable>
  );
}

export function InlineError({ message, palette }: { message: string; palette: ThemePalette }) {
  const styles = makeStyles(palette);
  return <Text style={styles.error}>{message}</Text>;
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    header: { paddingHorizontal: 24, paddingTop: 24, paddingBottom: 18 },
    eyebrow: { color: p.accent, fontSize: 12, fontWeight: '900', letterSpacing: 4 },
    title: { color: p.text, fontSize: 38, lineHeight: 44, fontWeight: '900', marginTop: 7 },
    subtitle: { color: p.mutedText, fontSize: 16, lineHeight: 23, marginTop: 5 },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 38, paddingBottom: 90 },
    emptyIcon: { width: 92, height: 92, borderRadius: 32, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center' },
    emptySymbol: { color: p.accent, fontSize: 42, fontWeight: '800' },
    emptyTitle: { color: p.text, fontSize: 22, fontWeight: '900', marginTop: 20 },
    emptyBody: { color: p.mutedText, fontSize: 16, lineHeight: 23, textAlign: 'center', marginTop: 8 },
    fab: { position: 'absolute', right: 24, bottom: 22, width: 64, height: 64, borderRadius: 23, backgroundColor: p.accent, alignItems: 'center', justifyContent: 'center', elevation: 8, shadowColor: p.accentSecondary, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: { width: 0, height: 7 } },
    fabPlus: { color: p.onAccent, fontSize: 34, lineHeight: 38, fontWeight: '500' },
    pressed: { opacity: 0.82, transform: [{ scale: 0.97 }] },
    error: { color: p.danger, fontSize: 14, lineHeight: 20, marginTop: 10 },
  });
}

