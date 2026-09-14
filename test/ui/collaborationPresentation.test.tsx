import React from 'react';
import { create } from 'zustand';
import TestRenderer,{act} from 'react-test-renderer';
import { ListsScreen } from '../../src/ui/ListsScreen';
import { getThemePalette } from '../../src/ui/theme';
import type { List,ListItem } from '../../src/data/lists';

const baseList={classId:null,position:0,rev:1,createdAt:'2026',updatedAt:'2026'};
const baseItem={position:0,rev:1,createdAt:'2026',updatedAt:'2026',completedByAvatarDataUri:null};
function model(lists:List[],items:Record<string,ListItem[]>) {
  return create(()=>({lists,itemsByListId:items,loadLists:jest.fn(async()=>undefined),createList:jest.fn(async()=>undefined),deleteList:jest.fn(async()=>undefined),loadItems:jest.fn(async()=>undefined),addItem:jest.fn(async()=>undefined),toggleItem:jest.fn(async()=>undefined),removeItem:jest.fn(async()=>undefined)}));
}

describe('collaboration list presentation',()=>{
  it('shows wedding rings for PARTNER while preserving the ordinary checked checkbox',async()=>{
    const list:List={...baseList,id:'partner',title:'Shopping List',purpose:'shopping',sharingMode:'partner',sharedRevision:4,collaborationRole:'partner'};
    const item:ListItem={...baseItem,id:'p-item',listId:list.id,text:'Хлеб',checked:true,completedByPublicClientId:null,completedByDisplayName:null,completedByHasAvatar:false,completedByAvatarVersion:null};
    let tree!:TestRenderer.ReactTestRenderer;
    await act(async()=>{tree=TestRenderer.create(<ListsScreen store={model([list],{partner:[item]}) as never} palette={getThemePalette('light')}/>);});
    expect(tree.root.findByProps({testID:'partner-rings-partner'}).props.children).toBe('💍💍');
    await act(async()=>tree.root.findByProps({testID:'list-partner'}).props.onPress());
    expect(tree.root.findByProps({testID:'toggle-item-p-item'}).props.accessibilityState.checked).toBe(true);
    expect(tree.root.findAllByProps({testID:'completion-avatar-p-item'})).toHaveLength(0);
    await act(async()=>tree.unmount());
  });

  it('replaces only a completed SHARED checkbox with the completer avatar initials in the same control slot',async()=>{
    const list:List={...baseList,id:'shared',title:'Дача',purpose:'generic',sharingMode:'shared',sharedRevision:2,collaborationRole:'editor'};
    const item:ListItem={...baseItem,id:'s-item',listId:list.id,text:'Купить краску',checked:true,completedByPublicClientId:'YU-AAAA-AAAA',completedByDisplayName:'Анна Иванова',completedByHasAvatar:false,completedByAvatarVersion:0};
    let tree!:TestRenderer.ReactTestRenderer;
    await act(async()=>{tree=TestRenderer.create(<ListsScreen store={model([list],{shared:[item]}) as never} palette={getThemePalette('dark')}/>);});
    await act(async()=>tree.root.findByProps({testID:'list-shared'}).props.onPress());
    const avatar=tree.root.findByProps({testID:'completion-avatar-s-item'});
    expect(avatar.props.accessibilityLabel).toBe('Выполнил: Анна Иванова');
    expect(avatar.findByType(require('react-native').Text).props.children).toBe('АИ');
    expect(tree.root.findAllByProps({testID:'toggle-item-s-item'})).toHaveLength(0);
    expect(tree.root.findAllByProps({testID:'delete-list'})).toHaveLength(0);
    await act(async()=>tree.unmount());
  });
});
