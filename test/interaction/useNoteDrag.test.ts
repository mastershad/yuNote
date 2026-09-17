import { resolveDrop } from '../../src/interaction/useNoteDrag';

describe('resolveDrop (spec §6 drop-target -> mutation mapping)', () => {
  const calls = () => {
    const createClassFromNotes = jest.fn();
    const addNoteToClass = jest.fn();
    const removeNoteFromClass = jest.fn();
    const deleteNote = jest.fn();
    return { createClassFromNotes, addNoteToClass, removeNoteFromClass, deleteNote };
  };

  it('root: dropping a note on another note creates a class', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'n2', targetType: 'note' }, fns);
    expect(fns.createClassFromNotes).toHaveBeenCalledWith({ noteAId: 'n1', noteBId: 'n2' });
  });

  it('root: dropping a note on a class adds it', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'c1', targetType: 'class' }, fns);
    expect(fns.addNoteToClass).toHaveBeenCalledWith({ noteId: 'n1', classId: 'c1' });
  });

  it('root: dropping a note on the delete zone deletes it', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'delete-zone', targetType: 'delete' }, fns);
    expect(fns.deleteNote).toHaveBeenCalledWith('n1');
  });

  it('root: dropping on nothing (targetId null) does nothing', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: null, targetType: null }, fns);
    expect(fns.createClassFromNotes).not.toHaveBeenCalled();
    expect(fns.addNoteToClass).not.toHaveBeenCalled();
    expect(fns.deleteNote).not.toHaveBeenCalled();
  });

  it('class view: dropping on the delete zone deletes the note', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'class', classId: 'c1' }, draggedId: 'n1', targetId: 'delete-zone', targetType: 'delete' }, fns);
    expect(fns.deleteNote).toHaveBeenCalledWith('n1');
  });

  it('class view: dropping on the "All Notes" zone removes the note from the class', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'class', classId: 'c1' }, draggedId: 'n1', targetId: 'all-notes-zone', targetType: 'all-notes' }, fns);
    expect(fns.removeNoteFromClass).toHaveBeenCalledWith('n1');
  });

  it('class view: dropping on another note in the same class is invalid -- no mutation', async () => {
    const fns = calls();
    await resolveDrop({ screen: { view: 'class', classId: 'c1' }, draggedId: 'n1', targetId: 'n2', targetType: 'note' }, fns);
    expect(fns.createClassFromNotes).not.toHaveBeenCalled();
    expect(fns.addNoteToClass).not.toHaveBeenCalled();
  });

  it('a rejected mutation (e.g. stale assumption) does not throw out of resolveDrop -- caller treats it as a cancelled drop', async () => {
    const fns = calls();
    fns.createClassFromNotes.mockRejectedValue(new Error('One or both notes already belongs to a class'));

    await expect(
      resolveDrop({ screen: { view: 'root' }, draggedId: 'n1', targetId: 'n2', targetType: 'note' }, fns),
    ).resolves.toBeUndefined();
  });
});
