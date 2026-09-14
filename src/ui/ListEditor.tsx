import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Image,
} from 'react-native';
import type { List, ListItem } from '../data/lists';

const EMPTY_ITEMS: ListItem[] = [];
import { createListsStore } from '../state/listsStore';
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

  useEffect(() => {
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

  const remove = async (itemId: string) => {
    setError('');
    try {
      await props.store.getState().removeItem(list.id, itemId);
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Не удалось удалить пункт');
    }
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
      <View style={styles.safe}>
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
            <View key={item.id} style={styles.item}>
              {list.sharingMode==='shared'&&item.checked?(
                <View testID={`completion-avatar-${item.id}`} accessibilityLabel={`Выполнил: ${item.completedByDisplayName??item.completedByPublicClientId}`} style={styles.completionAvatar}>
                  {item.completedByAvatarDataUri?<Image source={{uri:item.completedByAvatarDataUri}} style={styles.completionImage}/>:<Text style={styles.completionInitials}>{initials(item.completedByDisplayName??item.completedByPublicClientId??'')}</Text>}
                </View>
              ):(<Pressable
                testID={`toggle-item-${item.id}`}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: item.checked }}
                disabled={!canEdit}
                onPress={() => canEdit&&void props.store.getState().toggleItem(list.id, item.id)}
                style={[styles.checkbox, item.checked && styles.checkboxChecked]}>
                {item.checked ? <Text style={styles.check}>✓</Text> : null}
              </Pressable>)}
              <Text style={[styles.itemText, item.checked && styles.itemDone]}>{item.text}</Text>
              {canEdit?<Pressable testID={`remove-item-${item.id}`} onPress={() => void remove(item.id)} hitSlop={12}>
                <Text style={styles.remove}>×</Text>
              </Pressable>:null}
            </View>
          ))}
        </ScrollView>
      </View>
    </Modal>
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
    remove: { color: p.mutedText, fontSize: 27, fontWeight: '500' },
  });
}

