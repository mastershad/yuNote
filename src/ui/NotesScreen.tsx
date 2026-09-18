import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { GestureDetector } from 'react-native-gesture-handler';
import type { Note } from '../data/notes';
import type { Class } from '../data/classes';
import type { OpSqliteDb } from '../db/connection';
import type { Rect } from '../interaction/dropTargetRegistry';
import { useNoteDrag } from '../interaction/useNoteDrag';
import { createNotesStore } from '../state/notesStore';
import { createClassesStore } from '../state/classesStore';
import { EmptyState, FloatingAddButton, InlineError, ScreenHeader } from './components';
import { ClassCard } from './ClassCard';
import { ClassViewHeader } from './ClassViewHeader';
import { NoteEditor } from './NoteEditor';
import type { ThemePalette } from './theme';

const EMPTY_RECT: Rect = { x: 0, y: 0, width: 0, height: 0 };
type TargetTypeGuess = 'note' | 'class' | 'delete' | 'all-notes' | null;

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
  db: OpSqliteDb;
  palette: ThemePalette;
}) {
  const notes = props.store(state => state.notes);
  const classes = props.classesStore(state => state.classes);
  const noteCounts = props.classesStore(state => state.noteCounts);
  const [screen, setScreen] = useState<ScreenState>({ view: 'root' });
  const [editing, setEditing] = useState<Note | 'new' | null>(null);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);
  const deleteZoneRef = useRef<View>(null);
  const allNotesZoneRef = useRef<View>(null);

  const drag = useNoteDrag({
    db: props.db,
    notesStore: props.store,
    classesStore: props.classesStore,
    screen: screen.view === 'root' ? { view: 'root' } : { view: 'class', classId: screen.classId },
  });

  // The Delete/All-Notes zones only exist in the tree (and re-register their
  // rect via onLayout) while draggingId !== null; once a drag ends they
  // unmount without an onLayout to unregister themselves, so their last
  // rect would otherwise linger in the registry and could wrongly hit-test
  // against a *later* drag that never renders them (e.g. a later drag on
  // root, where 'all-notes-zone' never appears at all). Clearing both ids
  // whenever a drag ends keeps the registry matching what's actually shown.
  useEffect(() => {
    if (drag.draggingId === null) {
      drag.unregisterTarget('delete-zone');
      drag.unregisterTarget('all-notes-zone');
    }
  }, [drag.draggingId]);

  // Root feed: a dropped-on id might be either a note (-> merge into a new
  // class) or a class (-> add to it) -- resolve from the feed actually on
  // screen. Class view: everything rendered is a note; the delete/all-notes
  // zone ids fall through to useNoteDrag's own targetTypeFor instead (this
  // function returns null for them, same as an unrecognized id would).
  const idToType = useMemo((): ((id: string) => TargetTypeGuess) => {
    if (screen.view === 'root') {
      const map = new Map<string, 'note' | 'class'>();
      mergeRootFeed(notes, classes).forEach(item => {
        map.set(item.type === 'note' ? item.note.id : item.klass.id, item.type);
      });
      return id => map.get(id) ?? null;
    }
    const noteIds = new Set(notes.map(n => n.id));
    return id => (noteIds.has(id) ? 'note' : null);
  }, [screen.view, notes, classes]);

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
              <DropTargetLayout id={item.klass.id} drag={drag}>
                <ClassCard
                  klass={item.klass}
                  noteCount={noteCounts[item.klass.id] ?? 0}
                  onPress={() => setScreen({ view: 'class', classId: item.klass.id, className: item.klass.name })}
                  palette={props.palette}
                  hovered={drag.hoveredTargetId === item.klass.id}
                />
              </DropTargetLayout>
            ) : (
              <DraggableNoteCard
                note={item.note}
                drag={drag}
                idToType={idToType}
                onPress={() => setEditing(item.note)}
                styles={styles}
              />
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
            <DraggableNoteCard
              note={item}
              drag={drag}
              idToType={idToType}
              onPress={() => setEditing(item)}
              styles={styles}
            />
          )}
          ListEmptyComponent={
            <EmptyState symbol="✎" title="Класс пуст" body="Перетащите сюда заметку с главного экрана." palette={props.palette} />
          }
        />
      )}
      {drag.draggingId !== null ? (
        <View
          ref={deleteZoneRef}
          testID="drag-delete-zone"
          onLayout={() => {
            deleteZoneRef.current?.measureInWindow((x, y, width, height) => {
              drag.registerTarget('delete-zone', { x, y, width, height });
            });
          }}
          style={styles.deleteZone}>
          <Text style={styles.deleteZoneLabel}>🗑 Удалить</Text>
        </View>
      ) : null}
      {drag.draggingId !== null && screen.view === 'class' ? (
        <View
          ref={allNotesZoneRef}
          testID="drag-all-notes-zone"
          onLayout={() => {
            allNotesZoneRef.current?.measureInWindow((x, y, width, height) => {
              drag.registerTarget('all-notes-zone', { x, y, width, height });
            });
          }}
          style={styles.allNotesZone}>
          <Text style={styles.allNotesZoneLabel}>↑ Все заметки</Text>
        </View>
      ) : null}
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

// Wraps a non-draggable drop target (a root-feed ClassCard) so it registers
// its rect with the drop-target registry and cleans that entry up again on
// unmount (e.g. the class is deleted, or the feed re-sorts it out from
// under the list) -- ClassCard itself stays tap-only per spec §6, this is
// purely plumbing around it.
function DropTargetLayout(props: { id: string; drag: ReturnType<typeof useNoteDrag>; children: React.ReactNode }) {
  const viewRef = useRef<View>(null);
  // Depend on the stable unregisterTarget reference (useCallback'd inside
  // useNoteDrag), not the whole drag object -- drag is a fresh object every
  // render, which made this cleanup fire (and silently wipe the
  // registration) on every unrelated re-render, not just real unmounts.
  useEffect(() => () => props.drag.unregisterTarget(props.id), [props.drag.unregisterTarget, props.id]);
  return (
    <View
      ref={viewRef}
      onLayout={() => {
        viewRef.current?.measureInWindow((x, y, width, height) => {
          props.drag.registerTarget(props.id, { x, y, width, height });
        });
      }}>
      {props.children}
    </View>
  );
}

// A single note card as both a drag source (long-press-and-pan, via
// useDraggable/useNoteDrag) and a drop target (another dragged note can
// land on it to form a new class). measureOrigin reads originRef rather
// than calling the async measureInWindow synchronously -- the ref is kept
// current by onLayout re-measuring on every layout pass.
function DraggableNoteCard(props: {
  note: Note;
  drag: ReturnType<typeof useNoteDrag>;
  idToType: (id: string) => TargetTypeGuess;
  onPress(): void;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { note, drag, idToType, onPress, styles } = props;
  const originRef = useRef<Rect>(EMPTY_RECT);
  const cardRef = useRef<View>(null);

  // Same reasoning as DropTargetLayout above: depend on the stable
  // unregisterTarget reference, not the whole (fresh-every-render) drag
  // object.
  useEffect(() => () => drag.unregisterTarget(note.id), [drag.unregisterTarget, note.id]);

  const gesture = drag.useDragForNote(note.id, () => originRef.current, idToType);
  const isDragging = drag.draggingId === note.id;

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        ref={cardRef}
        onLayout={() => {
          cardRef.current?.measureInWindow((x, y, width, height) => {
            const rect = { x, y, width, height };
            originRef.current = rect;
            drag.registerTarget(note.id, rect);
          });
        }}
        style={[styles.card, isDragging && drag.animation.style]}>
        <Pressable
          testID={`note-${note.id}`}
          onPress={onPress}
          style={({ pressed }) => [styles.cardInner, pressed && styles.pressed]}>
          <View style={styles.cardAccent} />
          <View style={styles.cardContent}>
            <Text numberOfLines={1} style={styles.cardTitle}>{note.title || 'Без названия'}</Text>
            <Text numberOfLines={3} style={styles.cardBody}>{note.content || 'Пустая заметка'}</Text>
            <Text style={styles.cardMeta}>{formatDate(note.updatedAt)}</Text>
          </View>
        </Pressable>
      </Animated.View>
    </GestureDetector>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: p.background },
    list: { paddingHorizontal: 20, paddingBottom: 108, gap: 13 },
    emptyList: { flexGrow: 1 },
    errorWrap: { paddingHorizontal: 24 },
    card: { minHeight: 132, flexDirection: 'row', overflow: 'hidden', borderRadius: 24, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface, elevation: 2, shadowColor: '#000', shadowOpacity: p.mode === 'dark' ? 0.18 : 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
    cardInner: { flex: 1, flexDirection: 'row' },
    cardAccent: { width: 6, backgroundColor: p.accent },
    cardContent: { flex: 1, paddingHorizontal: 18, paddingVertical: 16 },
    cardTitle: { color: p.text, fontSize: 19, fontWeight: '900' },
    cardBody: { color: p.mutedText, fontSize: 15, lineHeight: 21, marginTop: 7 },
    cardMeta: { color: p.accent, fontSize: 12, fontWeight: '800', marginTop: 11 },
    pressed: { opacity: 0.78, transform: [{ scale: 0.99 }] },
    // Temporary drop targets (spec §6): fixed/absolute so they never occupy
    // list flow and only exist in the tree while a drag is in progress.
    // Delete sits at the bottom (root and class view); All Notes sits at
    // the top (class view only) per spec §6's diagram.
    deleteZone: {
      position: 'absolute', left: 20, right: 20, bottom: 24, minHeight: 64,
      borderRadius: 20, alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.danger, elevation: 4, shadowColor: '#000',
      shadowOpacity: 0.2, shadowRadius: 10, shadowOffset: { width: 0, height: 4 },
    },
    deleteZoneLabel: { color: p.onAccent, fontSize: 16, fontWeight: '800' },
    allNotesZone: {
      position: 'absolute', left: 20, right: 20, top: 12, minHeight: 56,
      borderRadius: 18, alignItems: 'center', justifyContent: 'center',
      backgroundColor: p.accentSoft, borderWidth: 1, borderColor: p.accent,
    },
    allNotesZoneLabel: { color: p.accent, fontSize: 15, fontWeight: '800' },
  });
}
