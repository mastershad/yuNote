import React from 'react';
import { Text } from 'react-native';
import { create } from 'zustand';
import TestRenderer, { act } from 'react-test-renderer';
import { NotesScreen } from '../../src/ui/NotesScreen';
import { getThemePalette } from '../../src/ui/theme';
import type { Note } from '../../src/data/notes';
import type { Class } from '../../src/data/classes';

function note(overrides: Partial<Note> = {}): Note {
  return {
    id: 'n1', title: 'Заметка', content: '', classId: null, rev: 1, position: 0,
    createdAt: '2026-09-17T08:00:00.000Z', updatedAt: '2026-09-17T08:00:00.000Z',
    ...overrides,
  };
}

function klass(overrides: Partial<Class> = {}): Class {
  return { id: 'c1', name: 'Работа', createdAt: '2026-09-17T07:00:00.000Z', updatedAt: '2026-09-17T09:00:00.000Z', rev: 1, position: 0, ...overrides };
}

function stores(notes: Note[], classes: Class[], noteCounts: Record<string, number> = {}) {
  const notesStore = create(() => ({
    notes, loadNotes: jest.fn(async () => undefined),
    createNote: jest.fn(), updateNote: jest.fn(), deleteNote: jest.fn(),
  }));
  const classesStore = create(() => ({
    classes, noteCounts, loadClasses: jest.fn(async () => undefined),
    createClass: jest.fn(), deleteClass: jest.fn(),
    renameClass: jest.fn(async (id: string, name: string) => ({ ...classes[0], id, name })),
  }));
  return { notesStore, classesStore };
}

describe('NotesScreen: Classes navigation and merged feed', () => {
  it('renders a merged, date-desc-sorted feed of root notes and classes', async () => {
    const older = note({ id: 'n1', title: 'Старая', updatedAt: '2026-09-17T06:00:00.000Z' });
    const newer = klass({ id: 'c1', name: 'Новее', updatedAt: '2026-09-17T09:00:00.000Z' });
    const { notesStore, classesStore } = stores([older], [newer]);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });

    expect(tree.root.findByProps({ testID: 'class-c1' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'note-n1' })).toBeTruthy();
  });

  it('tapping a class opens class view, showing only its own notes', async () => {
    const inClass = note({ id: 'n2', classId: 'c1' });
    const { notesStore, classesStore } = stores([], [klass()]);
    // classInClass's loadNotes is called again once the class view opens --
    // simulate that by having loadNotes populate the slice on the second call.
    let callCount = 0;
    (notesStore.getState().loadNotes as jest.Mock).mockImplementation(async () => {
      callCount++;
      if (callCount > 1) notesStore.setState({ notes: [inClass] });
    });

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());

    expect(notesStore.getState().loadNotes).toHaveBeenLastCalledWith({ classId: 'c1', sort: 'date-desc' });
    expect(tree.root.findByProps({ testID: 'class-back' })).toBeTruthy();
    expect(tree.root.findByProps({ testID: 'note-n2' })).toBeTruthy();
  });

  it('back arrow returns to root and reloads the root feed', async () => {
    const { notesStore, classesStore } = stores([], [klass()]);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'class-back' }).props.onPress());

    expect(tree.root.findByProps({ testID: 'class-c1' })).toBeTruthy();
    expect(notesStore.getState().loadNotes).toHaveBeenLastCalledWith({ classId: null, sort: 'date-desc' });
  });

  it('tapping the class name in class view enters rename mode, saved on submit', async () => {
    const { notesStore, classesStore } = stores([], [klass()]);

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });
    await act(async () => tree.root.findByProps({ testID: 'class-c1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'class-name-label' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'class-name-input' }).props.onChangeText('Проекты'));
    await act(async () => tree.root.findByProps({ testID: 'class-name-input' }).props.onSubmitEditing());

    expect(classesStore.getState().renameClass).toHaveBeenCalledWith('c1', 'Проекты');
  });

  it('a class with a member count shows it, not a content preview', async () => {
    // listClassNoteCounts (src/data/classes.ts) never emits an entry for a
    // class with zero member notes -- that's the real case NotesScreen's
    // `noteCounts[item.klass.id] ?? 0` fallback guards against, so this
    // fixture deliberately omits c1 from the counts map rather than giving
    // it an explicit count, or a removed `?? 0` would go undetected here.
    const { notesStore, classesStore } = stores([], [klass({ id: 'c1' })], {});

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(
        <NotesScreen store={notesStore as never} classesStore={classesStore as never} palette={getThemePalette('light')} />,
      );
    });

    // findByProps({testID}) confirms the card exists; the string check itself
    // reads the rendered Text nodes directly rather than JSON.stringify(card)
    // (or JSON.stringify(tree.toJSON())) -- both throw "Converting circular
    // structure to JSON" in this React 19 / react-test-renderer 19
    // environment: any ReactTestInstance here carries a plain enumerable
    // `_fiber` back-reference (fibers are inherently circular via
    // return/child/sibling/alternate), which neither raw JSON.stringify nor
    // the renderer's own toJSON() can serialize -- not specific to FlatList
    // rows. Checking the actual rendered text is the same assertion in
    // substance -- does "undefined заметок" appear anywhere on screen --
    // without depending on JSON-serializability of the fiber tree.
    tree.root.findByProps({ testID: 'class-c1' });
    const renderedText = tree.root
      .findAllByType(Text)
      .map(instance => (Array.isArray(instance.props.children) ? instance.props.children.join('') : instance.props.children))
      .join(' | ');
    expect(renderedText).toContain('0 заметок');
    expect(renderedText).not.toContain('undefined заметок');
  });
});
