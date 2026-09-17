import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Note } from '../data/notes';
import type { Class } from '../data/classes';
import { createNotesStore } from '../state/notesStore';
import { createClassesStore } from '../state/classesStore';
import { EmptyState, FloatingAddButton, InlineError, ScreenHeader } from './components';
import { ClassCard } from './ClassCard';
import { ClassViewHeader } from './ClassViewHeader';
import { NoteEditor } from './NoteEditor';
import type { ThemePalette } from './theme';

type ScreenState = { view: 'root' } | { view: 'class'; classId: string; className: string };
type FeedItem = { type: 'note'; note: Note } | { type: 'class'; klass: Class };

function mergeRootFeed(notes: Note[], classes: Class[]): FeedItem[] {
  const items: FeedItem[] = [
    ...notes.map((note): FeedItem => ({ type: 'note', note })),
    ...classes.map((klass): FeedItem => ({ type: 'class', klass })),
  ];
  return items.sort((a, b) => {
    const aTime = a.type === 'note' ? a.note.updatedAt : a.klass.updatedAt;
    const bTime = b.type === 'note' ? b.note.updatedAt : b.klass.updatedAt;
    return bTime.localeCompare(aTime);
  });
}

export function NotesScreen(props: {
  store: ReturnType<typeof createNotesStore>;
  classesStore: ReturnType<typeof createClassesStore>;
  palette: ThemePalette;
}) {
  const notes = props.store(state => state.notes);
  const classes = props.classesStore(state => state.classes);
  const noteCounts = props.classesStore(state => state.noteCounts);
  const [screen, setScreen] = useState<ScreenState>({ view: 'root' });
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);

  useEffect(() => {
    const loadForScreen = screen.view === 'root'
      ? props.store.getState().loadNotes({ classId: null, sort: 'date-desc' })
      : props.store.getState().loadNotes({ classId: screen.classId, sort: 'date-desc' });
    Promise.all([loadForScreen, props.classesStore.getState().loadClasses()]).catch(loadError => {
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить заметки');
    });
  }, [props.store, props.classesStore, screen]);

  const selectedNote = editing === 'new' || editing === null ? null : editing;
  const feed = screen.view === 'root' ? mergeRootFeed(notes, classes) : null;

  return (
    <View testID="notes-screen" style={styles.screen}>
      {screen.view === 'root' ? (
        <ScreenHeader eyebrow="YUNOTE" title="Заметки" subtitle="Ваши мысли всегда рядом." palette={props.palette} />
      ) : (
        <ClassViewHeader
          name={screen.className}
          onBack={() => setScreen({ view: 'root' })}
          onRename={async (name) => {
            const renamed = await props.classesStore.getState().renameClass(screen.classId, name);
            setScreen({ view: 'class', classId: renamed.id, className: renamed.name });
          }}
          palette={props.palette}
        />
      )}
      {error ? <View style={styles.errorWrap}><InlineError message={error} palette={props.palette} /></View> : null}
      {screen.view === 'root' ? (
        <FlatList
          data={feed as FeedItem[]}
          keyExtractor={item => (item.type === 'note' ? item.note.id : item.klass.id)}
          contentContainerStyle={feed && feed.length ? styles.list : styles.emptyList}
          renderItem={({ item }) =>
            item.type === 'class' ? (
              <ClassCard
                klass={item.klass}
                noteCount={noteCounts[item.klass.id] ?? 0}
                onPress={() => setScreen({ view: 'class', classId: item.klass.id, className: item.klass.name })}
                palette={props.palette}
              />
            ) : (
              <Pressable
                testID={`note-${item.note.id}`}
                onPress={() => setEditing(item.note)}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <View style={styles.cardAccent} />
                <View style={styles.cardContent}>
                  <Text numberOfLines={1} style={styles.cardTitle}>{item.note.title || 'Без названия'}</Text>
                  <Text numberOfLines={3} style={styles.cardBody}>{item.note.content || 'Пустая заметка'}</Text>
                  <Text style={styles.cardMeta}>{formatDate(item.note.updatedAt)}</Text>
                </View>
              </Pressable>
            )
          }
          ListEmptyComponent={
            <EmptyState symbol="✎" title="Здесь появятся заметки" body="Сохраните первую мысль — она останется на телефоне." palette={props.palette} />
          }
        />
      ) : (
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
            <EmptyState symbol="✎" title="Класс пуст" body="Перетащите сюда заметку с главного экрана." palette={props.palette} />
          }
        />
      )}
      {screen.view === 'root' ? (
        <FloatingAddButton testID="add-note" label="Добавить заметку" onPress={() => setEditing('new')} palette={props.palette} />
      ) : null}
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
