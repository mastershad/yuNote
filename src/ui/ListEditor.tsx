import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import type { List, ListItem } from '../data/lists';

const EMPTY_ITEMS: ListItem[] = [];
import { createListsStore } from '../state/listsStore';
import { useSwipeToDelete } from '../interaction/useSwipeToDelete';
import { usePendingItemUndo } from './usePendingItemUndo';
import { InlineError } from './components';
import type { ThemePalette } from './theme';

export function ListEditor(props: {
  list: List | null;
  store: ReturnType<typeof createListsStore>;
  palette: ThemePalette;
  onClose(): void;
}) {
  const items = props.store(state => (props.list ? state.itemsByListId[props.list.id] ?? EMPTY_ITEMS : EMPTY_ITEMS));
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);
  // Called before the props.list-null early return below, so it must live
  // here rather than after it -- a hook can't be called conditionally.
  // Safe to assume props.list is non-null inside restore: the undo banner
  // that triggers it only ever renders in the branch below where list is
  // known non-null, and the effect below dismisses any pending undo the
  // instant props.list changes to a different list (or to null), before
  // this callback could ever fire against the wrong list.
  const pendingUndo = usePendingItemUndo((restoredText) =>
    props.store.getState().addItem(props.list!.id, restoredText).catch(restoreError => {
      setError(restoreError instanceof Error ? restoreError.message : 'Не удалось отменить удаление');
    }),
  );

  useEffect(() => {
    // ListEditor stays mounted across list switches (ListsScreen just
    // toggles props.list, it doesn't unmount/remount this component), so a
    // pending undo from the previously open list must not survive into a
    // different one -- otherwise tapping "Отменить" here would restore the
    // old list's item into whichever list happens to be open now.
    pendingUndo.dismiss();
    if (props.list) {
      setText('');
      setError('');
      props.store.getState().loadItems(props.list.id).catch(loadError => {
        setError(loadError instanceof Error ? loadError.message : 'Не удалось открыть список');
      });
    }
  }, [props.list, props.store]);

  if (!props.list) return null;
  const list = props.list;
  const canEdit=list.collaborationRole!=='viewer';

  const add = async () => {
    const value = text.trim();
    if (!value) {
      setError('Введите пункт списка');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await props.store.getState().addItem(list.id, value);
      setText('');
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : 'Не удалось добавить пункт');
    } finally {
      setBusy(false);
    }
  };

  const commitSwipeDelete = (item: ListItem) => {
    setError('');
    props.store.getState().removeItem(list.id, item.id).catch(removeError => {
      setError(removeError instanceof Error ? removeError.message : 'Не удалось удалить пункт');
    });
    pendingUndo.show({ itemId: item.id, text: item.text });
  };

  const confirmDelete = () => {
    Alert.alert('Удалить список?', 'Все пункты этого списка будут удалены.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          void props.store.getState().deleteList(list.id)
            .then(props.onClose)
            .catch(deleteError => {
              setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить список');
            })
            .finally(() => setBusy(false));
        },
      },
    ]);
  };

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      {/* react-native-gesture-handler requires its own root inside a Modal on
          Android -- the Modal mounts in a separate native window, so the
          app-level GestureHandlerRootView in App.tsx doesn't cover it. */}
      <GestureHandlerRootView style={styles.safe}>
        <View style={styles.topBar}>
          <Pressable onPress={props.onClose} hitSlop={12}><Text style={styles.back}>Закрыть</Text></Pressable>
          <Text style={styles.heading} numberOfLines={1}>{list.title}</Text>
          {list.sharingMode==='personal'?<Pressable testID="delete-list" onPress={confirmDelete} hitSlop={12}><Text style={styles.delete}>Удалить</Text></Pressable>:<View style={styles.actionPlaceholder}/>}
        </View>
        {canEdit?<View style={styles.addRow}>
          <TextInput
            testID="new-item-input"
            value={text}
            onChangeText={setText}
            onSubmitEditing={add}
            placeholder="Новый пункт"
            placeholderTextColor={props.palette.mutedText}
            style={styles.input}
            returnKeyType="done"
          />
          <Pressable testID="add-list-item" onPress={add} disabled={busy} style={styles.addButton}>
            {busy ? <ActivityIndicator color={props.palette.onAccent} /> : <Text style={styles.addText}>＋</Text>}
          </Pressable>
        </View>:null}
        {error ? <InlineError message={error} palette={props.palette} /> : null}
        <ScrollView contentContainerStyle={styles.items} keyboardShouldPersistTaps="handled">
          {items.length === 0 ? <Text style={styles.empty}>Добавьте первый пункт списка.</Text> : null}
          {items.map(item => (
            <ListItemRow
              key={item.id}
              item={item}
              sharingMode={list.sharingMode}
              canEdit={canEdit}
              styles={styles}
              onToggle={() => void props.store.getState().toggleItem(list.id, item.id)}
              onSwipeDelete={() => commitSwipeDelete(item)}
            />
          ))}
        </ScrollView>
        {pendingUndo.pending ? (
          <View style={styles.undoBanner}>
            <Text style={styles.undoText}>Пункт удалён</Text>
            <Pressable testID="undo-remove-item" onPress={pendingUndo.confirmUndo} hitSlop={12}>
              <Text style={styles.undoAction}>Отменить</Text>
            </Pressable>
          </View>
        ) : null}
      </GestureHandlerRootView>
    </Modal>
  );
}

// Swipe-to-delete lives on its own component (rather than inline in the
// .map() above) because useSwipeToDelete calls hooks -- each row needs an
// isolated hook-call sequence that doesn't shift when the item count
// changes, same reasoning as NotesScreen's DraggableNoteCard.
function ListItemRow(props: {
  item: ListItem;
  sharingMode: List['sharingMode'];
  canEdit: boolean;
  styles: ReturnType<typeof makeStyles>;
  onToggle(): void;
  onSwipeDelete(): void;
}) {
  const { item, sharingMode, canEdit, styles } = props;
  const [rowWidth, setRowWidth] = useState(0);
  const swipe = useSwipeToDelete(rowWidth, { enabled: canEdit, onCommit: props.onSwipeDelete });

  return (
    <GestureDetector gesture={swipe.gesture}>
      <Animated.View
        style={[styles.item, swipe.style]}
        onLayout={(event) => setRowWidth(event.nativeEvent.layout.width)}>
        {sharingMode==='shared'&&item.checked?(
          <View testID={`completion-avatar-${item.id}`} accessibilityLabel={`Выполнил: ${item.completedByDisplayName??item.completedByPublicClientId}`} style={styles.completionAvatar}>
            {item.completedByAvatarDataUri?<Image source={{uri:item.completedByAvatarDataUri}} style={styles.completionImage}/>:<Text style={styles.completionInitials}>{initials(item.completedByDisplayName??item.completedByPublicClientId??'')}</Text>}
          </View>
        ):(<Pressable
          testID={`toggle-item-${item.id}`}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: item.checked }}
          disabled={!canEdit}
          onPress={() => canEdit && props.onToggle()}
          style={[styles.checkbox, item.checked && styles.checkboxChecked]}>
          {item.checked ? <Text style={styles.check}>✓</Text> : null}
        </Pressable>)}
        <Text style={[styles.itemText, item.checked && styles.itemDone]}>{item.text}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function initials(value:string):string{
  const parts=value.trim().split(/\s+/).filter(Boolean);
  return (parts.length>1?`${parts[0][0]}${parts[1][0]}`:parts[0]?.slice(0,2)??'?').toUpperCase();
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background, paddingHorizontal: 22 },
    topBar: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    back: { color: p.mutedText, fontSize: 16, fontWeight: '700' },
    heading: { flex: 1, color: p.text, textAlign: 'center', fontSize: 18, fontWeight: '900' },
    delete: { color: p.danger, fontSize: 14, fontWeight: '800' },
    actionPlaceholder:{width:56},
    addRow: { flexDirection: 'row', gap: 10, marginTop: 22 },
    input: { flex: 1, height: 54, borderRadius: 18, paddingHorizontal: 18, backgroundColor: p.input, color: p.text, fontSize: 17 },
    addButton: { width: 54, height: 54, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: p.accent },
    addText: { color: p.onAccent, fontSize: 28, lineHeight: 32 },
    items: { gap: 10, paddingTop: 22, paddingBottom: 30 },
    empty: { color: p.mutedText, textAlign: 'center', fontSize: 16, marginTop: 36 },
    item: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 15, borderRadius: 19, borderWidth: 1, borderColor: p.border, backgroundColor: p.surface },
    checkbox: { width: 27, height: 27, borderRadius: 9, borderWidth: 2, borderColor: p.accent, alignItems: 'center', justifyContent: 'center' },
    checkboxChecked: { backgroundColor: p.accent },
    completionAvatar:{width:27,height:27,borderRadius:9,overflow:'hidden',alignItems:'center',justifyContent:'center',backgroundColor:p.accent},
    completionImage:{width:27,height:27},
    completionInitials:{color:p.onAccent,fontSize:10,fontWeight:'900'},
    check: { color: p.onAccent, fontWeight: '900' },
    itemText: { flex: 1, color: p.text, fontSize: 17, paddingVertical: 14 },
    itemDone: { color: p.mutedText, textDecorationLine: 'line-through' },
    undoBanner: { minHeight: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, marginBottom: 18, borderRadius: 16, backgroundColor: p.surface, borderWidth: 1, borderColor: p.border },
    undoText: { color: p.text, fontSize: 15 },
    undoAction: { color: p.accent, fontSize: 15, fontWeight: '800' },
  });
}

