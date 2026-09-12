import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { createAppStores, type AppStores } from './src/app/stores';
import { NotesScreen } from './src/ui/NotesScreen';
import { getThemePalette, type ThemePalette } from './src/ui/theme';

type Tab = 'notes' | 'lists';

export interface AppProps {
  bootstrap?: () => Promise<AppStores>;
}

export default function App({ bootstrap = createAppStores }: AppProps) {
  const mode = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = useMemo(() => getThemePalette(mode), [mode]);
  const styles = useMemo(() => createStyles(palette), [palette]);
  const [stores, setStores] = useState<AppStores | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<Tab>('notes');

  const retry = useCallback(() => {
    setStartupError(null);
    setStores(null);
    setAttempt(value => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    let opened: AppStores | null = null;
    bootstrap()
      .then(value => {
        opened = value;
        if (active) {
          setStores(value);
        } else {
          value.close();
        }
      })
      .catch(error => {
        if (active) {
          setStartupError(error instanceof Error ? error.message : 'Неизвестная ошибка');
        }
      });

    return () => {
      active = false;
      opened?.close();
    };
  }, [bootstrap, attempt]);

  return (
    <View style={styles.safeArea}>
      <StatusBar
        barStyle={mode === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={palette.statusBar}
      />
      {!stores && !startupError ? (
        <View style={styles.center} testID="startup-loading">
          <View style={styles.brandMark}><Text style={styles.brandEmoji}>🦝</Text></View>
          <ActivityIndicator size="large" color={palette.accent} />
          <Text style={styles.muted}>Открываем ваши заметки…</Text>
        </View>
      ) : null}
      {!stores && startupError ? (
        <View style={styles.center} testID="startup-error">
          <View style={styles.brandMark}><Text style={styles.brandEmoji}>🦝</Text></View>
          <Text style={styles.errorTitle}>Не удалось открыть заметки</Text>
          <Text style={styles.muted}>{startupError}</Text>
          <Pressable testID="startup-retry" onPress={retry} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Повторить</Text>
          </Pressable>
        </View>
      ) : null}
      {stores ? (
        <View style={styles.app}>
          <View style={styles.content}>
            {tab === 'notes' ? (
              <View testID="notes-screen" style={styles.placeholder}>
                <Text style={styles.eyebrow}>YUNOTE</Text>
                <Text style={styles.title}>Заметки</Text>
                <Text style={styles.muted}>Ваши мысли всегда рядом.</Text>
              </View>
            ) : (
              <View testID="lists-screen" style={styles.placeholder}>
                <Text style={styles.eyebrow}>YUNOTE</Text>
                <Text style={styles.title}>Списки</Text>
                <Text style={styles.muted}>Планы, покупки и важные дела.</Text>
              </View>
            )}
          </View>
          <View style={styles.tabBar}>
            <TabButton
              label="Заметки"
              symbol="▤"
              selected={tab === 'notes'}
              onPress={() => setTab('notes')}
              testID="tab-notes"
              palette={palette}
            />
            <TabButton
              label="Списки"
              symbol="✓"
              selected={tab === 'lists'}
              onPress={() => setTab('lists')}
              testID="tab-lists"
              palette={palette}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function TabButton(props: {
  label: string;
  symbol: string;
  selected: boolean;
  onPress(): void;
  testID: string;
  palette: ThemePalette;
}) {
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected: props.selected }}
      testID={props.testID}
      onPress={props.onPress}
      style={stylesBase.tabButton}>
      <View style={[stylesBase.tabIcon, props.selected && { backgroundColor: props.palette.accentSoft }]}>
        <Text style={{ color: props.selected ? props.palette.accent : props.palette.mutedText, fontSize: 22 }}>
          {props.symbol}
        </Text>
      </View>
      <Text style={{ color: props.selected ? props.palette.accent : props.palette.mutedText, fontWeight: '700' }}>
        {props.label}
      </Text>
    </Pressable>
  );
}

const stylesBase = StyleSheet.create({
  tabButton: { flex: 1, minHeight: 66, alignItems: 'center', justifyContent: 'center', gap: 2 },
  tabIcon: { width: 38, height: 30, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});

function createStyles(p: ThemePalette) {
  return StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: p.background },
    app: { flex: 1 },
    content: { flex: 1 },
    placeholder: { flex: 1, paddingHorizontal: 24, paddingTop: 28 },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 18 },
    brandMark: { width: 92, height: 92, borderRadius: 30, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accentSoft },
    brandEmoji: { fontSize: 50 },
    eyebrow: { color: p.accent, fontWeight: '900', letterSpacing: 4, fontSize: 13 },
    title: { color: p.text, fontSize: 38, lineHeight: 44, fontWeight: '900', marginTop: 8 },
    errorTitle: { color: p.text, fontSize: 24, fontWeight: '900', textAlign: 'center' },
    muted: { color: p.mutedText, fontSize: 17, lineHeight: 24, textAlign: 'center' },
    primaryButton: { minHeight: 52, paddingHorizontal: 26, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accent },
    primaryButtonText: { color: p.onAccent, fontSize: 16, fontWeight: '800' },
    tabBar: { flexDirection: 'row', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: p.border, backgroundColor: p.surface, paddingBottom: 4 },
  });
}

