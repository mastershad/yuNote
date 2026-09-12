import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Note } from '../data/notes';
import { createNotesStore } from '../state/notesStore';
import { EmptyState, FloatingAddButton, InlineError, ScreenHeader } from './components';
import { NoteEditor } from './NoteEditor';
import type { ThemePalette } from './theme';

export function NotesScreen(props: {
  store: ReturnType<typeof createNotesStore>;
  palette: ThemePalette;
}) {
  const notes = props.store(state => state.notes);
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);

  useEffect(() => {
    props.store.getState().loadNotes({ sort: 'date-desc' }).catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить заметки');
    });
  }, [props.store]);

  const selectedNote = editing === 'new' || editing === null ? null : editing;

  return (
    <View testID="notes-screen" style={styles.screen}>
      <ScreenHeader eyebrow="YUNOTE" title="Заметки" subtitle="Ваши мысли всегда рядом." palette={props.palette} />
      {error ? <View style={styles.errorWrap}><InlineError message={error} palette={props.palette} /></View> : null}
      <FlatList
        data={notes}
        keyExtractor={item => item.id}
        contentContainerStyle={notes.length ? styles.list : styles.emptyList}
        renderItem={({ item }) => (
          <Pressable
            testID={`note-${item.id}`}
            onPress={() => setEditing(item)}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
            <View style={styles.cardAccent} />
            <View style={styles.cardContent}>
              <Text numberOfLines={1} style={styles.cardTitle}>{item.title || 'Без названия'}</Text>
              <Text numberOfLines={3} style={styles.cardBody}>{item.content || 'Пустая заметка'}</Text>
              <Text style={styles.cardMeta}>{formatDate(item.updatedAt)}</Text>
            </View>
          </Pressable>
        )}
        ListEmptyComponent={
          <EmptyState symbol="✎" title="Здесь появятся заметки" body="Сохраните первую мысль — она останется на телефоне." palette={props.palette} />
        }
      />
      <FloatingAddButton testID="add-note" label="Добавить заметку" onPress={() => setEditing('new')} palette={props.palette} />
      <NoteEditor
        visible={editing !== null}
        note={selectedNote}
        palette={props.palette}
        onClose={() => setEditing(null)}
        onSave={async input => {
          if (selectedNote) {
            await props.store.getState().updateNote(selectedNote.id, input);
          } else {
            await props.store.getState().createNote(input);
          }
        }}
        onDelete={selectedNote ? async () => props.store.getState().deleteNote(selectedNote.id) : undefined}
      />
    </View>
  );
}

function formatDate(iso: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? ''
    : value.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.background },
    list: { paddingHorizontal: 20, paddingBottom: 108, gap: 13 },
    emptyList: { flexGrow: 1 },
    errorWrap: { paddingHorizontal: 24 },
    card: { minHeight: 132, flexDirection: 'row', overflow: 'hidden', borderRadius: 24, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, elevation: 2, shadowColor: '#000', shadowOpacity: p.mode === 'dark' ? 0.18 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
    cardAccent: { width: 6, backgroundColor: p.accent },
    cardContent: { flex: 1, paddingHorizontal: 18, paddingVertical: 16 },
    cardTitle: { color: p.text, fontSize: 19, fontWeight: '900' },
    cardBody: { color: p.mutedText, fontSize: 15, lineHeight: 21, marginTop: 7 },
    cardMeta: { color: p.accent, fontSize: 12, fontWeight: '800', marginTop: 11 },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
  });
}

