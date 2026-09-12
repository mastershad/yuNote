import React from 'react';
import { create } from 'zustand';
import TestRenderer, { act } from 'react-test-renderer';
import App from '../../App';
import type { AppStores } from '../../src/app/stores';

function fakeStores(): AppStores {
  const notes = create(() => ({
    notes: [],
    loadNotes: jest.fn().mockResolvedValue(undefined),
    createNote: jest.fn(),
    updateNote: jest.fn(),
    deleteNote: jest.fn(),
  }));
  const lists = create(() => ({
    lists: [],
    itemsByListId: {},
    loadLists: jest.fn().mockResolvedValue(undefined),
    createList: jest.fn(),
    deleteList: jest.fn(),
    loadItems: jest.fn(),
    addItem: jest.fn(),
    toggleItem: jest.fn(),
    removeItem: jest.fn(),
  }));
  return { notes, lists, close: jest.fn() } as unknown as AppStores;
}

describe('App shell', () => {
  it('boots local stores and switches between Notes and Lists', async () => {
    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<App bootstrap={async () => fakeStores()} />);
    });

    expect(tree.root.findByProps({ testID: 'notes-screen' })).toBeTruthy();

    await act(async () => {
      tree.root.findByProps({ testID: 'tab-lists' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'lists-screen' })).toBeTruthy();
  });

  it('offers retry when local storage initialization fails', async () => {
    const bootstrap = jest
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(fakeStores());

    let tree!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      tree = TestRenderer.create(<App bootstrap={bootstrap} />);
    });

    expect(tree.root.findByProps({ testID: 'startup-error' })).toBeTruthy();

    await act(async () => {
      tree.root.findByProps({ testID: 'startup-retry' }).props.onPress();
    });

    expect(tree.root.findByProps({ testID: 'notes-screen' })).toBeTruthy();
    expect(bootstrap).toHaveBeenCalledTimes(2);
  });
});

