import React from 'react';
import { Alert } from 'react-native';
import { create } from 'zustand';
import TestRenderer, { act } from 'react-test-renderer';
import { NotesScreen } from '../../src/ui/NotesScreen';
import { getThemePalette } from '../../src/ui/theme';
import type { Note } from '../../src/data/notes';

function note(id = 'n1'): Note {
  return {
    id,
    title: 'Первая идея',
    content: 'Содержание',
    classId: null,
    rev: 1,
    position: 0,
    createdAt: '2026-09-12T08:00:00.000Z',
    updatedAt: '2026-09-12T08:00:00.000Z',
  };
}

function notesStore(initial: Note[] = []) {
  const createNote = jest.fn(async (input: { title: string; content: string }) => note('created'));
  const updateNote = jest.fn(async () => note());
  const deleteNote = jest.fn(async () => undefined);
  const store = create(() => ({
    notes: initial,
    loadNotes: jest.fn(async () => undefined),
    createNote,
    updateNote,
    deleteNote,
  }));
  return { store, createNote, updateNote, deleteNote };
}

describe('NotesScreen', () => {
  it('creates a note from the editor', async () => {
    const model = notesStore();
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={model.store as never} palette={getThemePalette('light')} />,
      );
    });

    await act(async () => tree.root.findByProps({ testID: 'add-note' }).props.onPress());
    await act(async () =>
      tree.root.findByProps({ testID: 'note-title-input' }).props.onChangeText('План'),
    );
    await act(async () =>
      tree.root.findByProps({ testID: 'note-body-input' }).props.onChangeText('Позвонить врачу'),
    );
    await act(async () => tree.root.findByProps({ testID: 'save-note' }).props.onPress());

    expect(model.createNote).toHaveBeenCalledWith({
      title: 'План',
      content: 'Позвонить врачу',
    });
  });

  it('updates and confirms deletion of an existing note', async () => {
    const model = notesStore([note()]);
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style === 'destructive')?.onPress?.();
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={model.store as never} palette={getThemePalette('dark')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'note-n1' }).props.onPress());
    await act(async () =>
      tree.root.findByProps({ testID: 'note-title-input' }).props.onChangeText('Обновлённая идея'),
    );
    await act(async () => tree.root.findByProps({ testID: 'save-note' }).props.onPress());

    expect(model.updateNote).toHaveBeenCalledWith('n1', {
      title: 'Обновлённая идея',
      content: 'Содержание',
    });

    await act(async () => tree.root.findByProps({ testID: 'note-n1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'delete-note' }).props.onPress());
    expect(model.deleteNote).toHaveBeenCalledWith('n1');
    await act(async () => tree.unmount());
  });
});

