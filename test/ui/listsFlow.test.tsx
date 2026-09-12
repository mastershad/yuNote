import React from 'react';
import { Alert } from 'react-native';
import { create } from 'zustand';
import TestRenderer, { act } from 'react-test-renderer';
import { ListsScreen } from '../../src/ui/ListsScreen';
import { getThemePalette } from '../../src/ui/theme';
import type { List, ListItem } from '../../src/data/lists';

const list: List = {
  id: 'l1',
  title: 'Покупки',
  classId: null,
  position: 0,
  rev: 1,
  createdAt: '2026-09-12T08:00:00.000Z',
  updatedAt: '2026-09-12T08:00:00.000Z',
};
const item: ListItem = {
  id: 'i1',
  listId: 'l1',
  text: 'Молоко',
  checked: false,
  position: 0,
  rev: 1,
  createdAt: '2026-09-12T08:00:00.000Z',
  updatedAt: '2026-09-12T08:00:00.000Z',
};

function listsStore(initialLists: List[] = [], items: ListItem[] = []) {
  const createList = jest.fn(async () => list);
  const deleteList = jest.fn(async () => undefined);
  const addItem = jest.fn(async () => item);
  const toggleItem = jest.fn(async () => undefined);
  const removeItem = jest.fn(async () => undefined);
  const store = create(() => ({
    lists: initialLists,
    itemsByListId: { l1: items },
    loadLists: jest.fn(async () => undefined),
    createList,
    deleteList,
    loadItems: jest.fn(async () => undefined),
    addItem,
    toggleItem,
    removeItem,
  }));
  return { store, createList, deleteList, addItem, toggleItem, removeItem };
}

describe('ListsScreen', () => {
  it('creates a named list and rejects blank input', async () => {
    const model = listsStore();
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<ListsScreen store={model.store as never} palette={getThemePalette('light')} />);
    });

    await act(async () => tree.root.findByProps({ testID: 'add-list' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'save-list' }).props.onPress());
    expect(model.createList).not.toHaveBeenCalled();
    expect(tree.root.findByProps({ testID: 'list-title-error' })).toBeTruthy();

    await act(async () => tree.root.findByProps({ testID: 'new-list-title' }).props.onChangeText('Покупки'));
    await act(async () => tree.root.findByProps({ testID: 'save-list' }).props.onPress());
    expect(model.createList).toHaveBeenCalledWith('Покупки');
    await act(async () => tree.unmount());
  });

  it('adds, toggles, removes an item and confirms list deletion', async () => {
    const model = listsStore([list], [item]);
    jest.spyOn(Alert, 'alert').mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style === 'destructive')?.onPress?.();
    });
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<ListsScreen store={model.store as never} palette={getThemePalette('dark')} />);
    });

    await act(async () => tree.root.findByProps({ testID: 'list-l1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'new-item-input' }).props.onChangeText('Хлеб'));
    await act(async () => tree.root.findByProps({ testID: 'add-list-item' }).props.onPress());
    expect(model.addItem).toHaveBeenCalledWith('l1', 'Хлеб');

    await act(async () => tree.root.findByProps({ testID: 'toggle-item-i1' }).props.onPress());
    await act(async () => tree.root.findByProps({ testID: 'remove-item-i1' }).props.onPress());
    expect(model.toggleItem).toHaveBeenCalledWith('l1', 'i1');
    expect(model.removeItem).toHaveBeenCalledWith('l1', 'i1');

    await act(async () => tree.root.findByProps({ testID: 'delete-list' }).props.onPress());
    expect(model.deleteList).toHaveBeenCalledWith('l1');
    await act(async () => tree.unmount());
  });
});

