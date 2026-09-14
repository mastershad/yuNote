import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { List } from '../data/lists';
import { createListsStore } from '../state/listsStore';
import { EmptyState, FloatingAddButton, InlineError, ScreenHeader } from './components';
import { ListEditor } from './ListEditor';
import type { ThemePalette } from './theme';

export function ListsScreen(props: {
  store: ReturnType<typeof createListsStore>;
  palette: ThemePalette;
}) {
  const lists = props.store(state => state.lists);
  const itemsByListId = props.store(state => state.itemsByListId);
  const [selected, setSelected] = useState<List | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);

  useEffect(() => {
    props.store.getState().loadLists().catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить списки');
    });
  }, [props.store]);

  useEffect(() => {
    lists.forEach(list => {
      if (!itemsByListId[list.id]) {
        void props.store.getState().loadItems(list.id);
      }
    });
  }, [lists, itemsByListId, props.store]);

  const startCreate = () => {
    setNewTitle('');
    setError('');
    setCreating(true);
  };

  const createList = async () => {
    const title = newTitle.trim();
    if (!title) {
      setError('Введите название списка');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await props.store.getState().createList(title);
      setCreating(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Не удалось создать список');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View testID="lists-screen" style={styles.screen}>
      <ScreenHeader eyebrow="YUNOTE" title="Списки" subtitle="Планы, покупки и важные дела." palette={props.palette} />
      {error && !creating ? <View style={styles.errorWrap}><InlineError message={error} palette={props.palette} /></View> : null}
      <ScrollView contentContainerStyle={lists.length ? styles.list : styles.emptyList}>
        {lists.length === 0 ? (
          <EmptyState symbol="✓" title="Создайте первый список" body="Добавляйте пункты и отмечайте выполненное." palette={props.palette} />
        ) : null}
        {lists.map(list => {
          const items = itemsByListId[list.id] ?? [];
          const completed = items.filter(item => item.checked).length;
          return (
            <Pressable
              key={list.id}
              testID={`list-${list.id}`}
              onPress={() => setSelected(list)}
              style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
              <View style={styles.listGlyph}><Text style={styles.listGlyphText}>✓</Text></View>
              <View style={styles.cardText}>
                <View style={styles.titleRow}>
                  {list.sharingMode==='partner'?<Text testID={`partner-rings-${list.id}`} accessibilityLabel="Партнёрский список" style={styles.rings}>💍💍</Text>:null}
                  <Text style={styles.cardTitle}>{list.title}</Text>
                </View>
                <Text style={styles.cardMeta}>{completed} из {items.length} выполнено</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <FloatingAddButton testID="add-list" label="Добавить список" onPress={startCreate} palette={props.palette} />
      <Modal visible={creating} transparent animationType="fade" onRequestClose={() => setCreating(false)}>
        <View style={styles.scrim}>
          <View style={styles.dialog}>
            <Text style={styles.dialogEyebrow}>НОВЫЙ СПИСОК</Text>
            <Text style={styles.dialogTitle}>Как его назвать?</Text>
            <TextInput
              autoFocus
              testID="new-list-title"
              value={newTitle}
              onChangeText={value => { setNewTitle(value); setError(''); }}
              onSubmitEditing={createList}
              placeholder="Например, Покупки"
              placeholderTextColor={props.palette.mutedText}
              style={styles.input}
              returnKeyType="done"
            />
            {error ? <Text testID="list-title-error" style={styles.validation}>{error}</Text> : null}
            <View style={styles.dialogActions}>
              <Pressable onPress={() => setCreating(false)} style={styles.secondaryButton}><Text style={styles.secondaryText}>Отмена</Text></Pressable>
              <Pressable testID="save-list" onPress={createList} disabled={busy} style={styles.primaryButton}>
                {busy ? <ActivityIndicator color={props.palette.onAccent} /> : <Text style={styles.primaryText}>Создать</Text>}
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <ListEditor list={selected} store={props.store} palette={props.palette} onClose={() => setSelected(null)} />
    </View>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.background },
    list: { paddingHorizontal: 20, paddingBottom: 108, gap: 13 },
    emptyList: { flexGrow: 1 },
    errorWrap: { paddingHorizontal: 24 },
    card: { minHeight: 88, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 15, borderRadius: 24, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, elevation: 2 },
    listGlyph: { width: 50, height: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accentSoft },
    listGlyphText: { color: p.accent, fontSize: 24, fontWeight: '900' },
    cardText: { flex: 1 },
    titleRow:{flexDirection:'row',alignItems:'center',gap:7},
    rings:{fontSize:16},
    cardTitle: { color: p.text, fontSize: 19, fontWeight: '900' },
    cardMeta: { color: p.mutedText, fontSize: 14, marginTop: 5 },
    chevron: { color: p.accent, fontSize: 32, fontWeight: '300' },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
    scrim: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: 'rgba(5,7,20,0.58)' },
    dialog: { borderRadius: 28, padding: 24, backgroundColor: p.surfaceRaised, borderWidth: 1, borderColor: p.border },
    dialogEyebrow: { color: p.accent, fontSize: 11, fontWeight: '900', letterSpacing: 3 },
    dialogTitle: { color: p.text, fontSize: 25, fontWeight: '900', marginTop: 8 },
    input: { height: 56, borderRadius: 18, marginTop: 20, paddingHorizontal: 17, backgroundColor: p.input, color: p.text, fontSize: 17 },
    validation: { color: p.danger, fontSize: 14, marginTop: 9 },
    dialogActions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 22 },
    secondaryButton: { minHeight: 48, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: p.input },
    secondaryText: { color: p.text, fontSize: 15, fontWeight: '800' },
    primaryButton: { minWidth: 112, minHeight: 48, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: p.accent },
    primaryText: { color: p.onAccent, fontSize: 15, fontWeight: '900' },
  });
}

