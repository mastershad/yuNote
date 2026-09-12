import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { Note } from '../data/notes';
import type { ThemePalette } from './theme';
import { InlineError } from './components';

export function NoteEditor(props: {
  note: Note | null;
  visible: boolean;
  palette: ThemePalette;
  onClose(): void;
  onSave(input: { title: string; content: string }): Promise<void>;
  onDelete?(): Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const styles = useMemo(() => makeStyles(props.palette), [props.palette]);

  useEffect(() => {
    if (props.visible) {
      setTitle(props.note?.title ?? '');
      setContent(props.note?.content ?? '');
      setError('');
    }
  }, [props.visible, props.note]);

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await props.onSave({ title: title.trim() || 'Без названия', content });
      props.onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Не удалось сохранить заметку');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      'Удалить заметку?',
      'Это действие нельзя отменить.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: () => {
            setBusy(true);
            setError('');
            void props.onDelete?.()
              .then(props.onClose)
              .catch(deleteError => {
                setError(deleteError instanceof Error ? deleteError.message : 'Не удалось удалить заметку');
              })
              .finally(() => setBusy(false));
          },
        },
      ],
    );
  };

  return (
    <Modal visible={props.visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={props.onClose}>
      <View style={styles.safe}>
        <View style={styles.topBar}>
          <Pressable onPress={props.onClose} hitSlop={12}><Text style={styles.secondaryAction}>Закрыть</Text></Pressable>
          <Text style={styles.editorTitle}>{props.note ? 'Редактирование' : 'Новая заметка'}</Text>
          <Pressable testID="save-note" onPress={save} disabled={busy} hitSlop={12}>
            {busy ? <ActivityIndicator color={props.palette.accent} /> : <Text style={styles.primaryAction}>Готово</Text>}
          </Pressable>
        </View>
        <TextInput
          testID="note-title-input"
          value={title}
          onChangeText={setTitle}
          placeholder="Название"
          placeholderTextColor={props.palette.mutedText}
          style={styles.titleInput}
          maxLength={160}
        />
        <TextInput
          testID="note-body-input"
          value={content}
          onChangeText={setContent}
          placeholder="Начните писать…"
          placeholderTextColor={props.palette.mutedText}
          style={styles.bodyInput}
          multiline
          textAlignVertical="top"
        />
        {error ? <InlineError message={error} palette={props.palette} /> : null}
        {props.note ? (
          <Pressable testID="delete-note" onPress={confirmDelete} disabled={busy} style={styles.deleteButton}>
            <Text style={styles.deleteText}>Удалить заметку</Text>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

function makeStyles(p: ThemePalette) {
  return StyleSheet.create({
    safe: { flex: 1, backgroundColor: p.background, paddingHorizontal: 22 },
    topBar: { minHeight: 64, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: p.border },
    editorTitle: { color: p.text, fontSize: 16, fontWeight: '800' },
    secondaryAction: { color: p.mutedText, fontSize: 16, fontWeight: '700' },
    primaryAction: { color: p.accent, fontSize: 16, fontWeight: '900' },
    titleInput: { color: p.text, fontSize: 31, lineHeight: 38, fontWeight: '900', paddingHorizontal: 0, paddingTop: 24, paddingBottom: 14 },
    bodyInput: { flex: 1, color: p.text, fontSize: 18, lineHeight: 27, paddingHorizontal: 0, paddingTop: 8 },
    deleteButton: { alignItems: 'center', paddingVertical: 18, marginBottom: 8 },
    deleteText: { color: p.danger, fontSize: 16, fontWeight: '800' },
  });
}

