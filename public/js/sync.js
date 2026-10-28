/* Applies live events to the local copy of a board. No DOM code, so it is unit-tested in Node.

   Rules that make it safe:
   - Each event has a version id. Version N+1 must follow N exactly.
       id <= current  -> duplicate: ignored (this also covers replays after a reconnect)
       id >  current+1 -> gap: something was missed, the caller must reload the whole board
   - Every event carries the full new state of what it touched, so applying one is idempotent
     (tasks are only overwritten by a higher `rev`).                                          */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Sync = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function upsertTask(d, t) {
    const i = d.tasks.findIndex((x) => x.id === t.id);
    if (i < 0) { d.tasks.push(Object.assign({}, t)); return true; }
    if ((t.rev || 0) > (d.tasks[i].rev || 0)) { Object.assign(d.tasks[i], t); return true; }
    return false;
  }
  function applyPositions(d, list) {
    (list || []).forEach((p) => {
      const t = d.tasks.find((x) => x.id === p.id);
      if (t) { t.columnId = p.columnId; t.position = p.position; }
    });
  }
  const sortCols = (d) => d.columns.sort((a, b) => a.position - b.position || a.id - b.id);

  /* state = { data: <board response>, version: <last applied event id> }
     opts.skipApply: only advance the version (used for this tab's own echoes while a request is in flight). */
  function apply(state, evt, opts) {
    if (evt.id <= state.version) return { status: 'duplicate', effects: [] };
    if (evt.id !== state.version + 1) return { status: 'gap', expected: state.version + 1, effects: [] };
    state.version = evt.id;
    state.data.board.version = evt.id;
    if (opts && opts.skipApply) return { status: 'skipped', effects: [] };

    const d = state.data, e = evt.data || {}, fx = [];
    switch (evt.type) {
      case 'task.created':
        if (upsertTask(d, e.task)) fx.push({ kind: 'task', id: e.task.id, created: true });
        break;
      case 'task.updated':
        if (upsertTask(d, e.task)) fx.push({ kind: 'task', id: e.task.id, changed: e.changed || [] });
        break;
      case 'task.moved':
        upsertTask(d, e.task);
        applyPositions(d, e.positions);
        fx.push({ kind: 'task', id: e.task.id, moved: true });
        break;
      case 'task.deleted':
        d.tasks = d.tasks.filter((t) => t.id !== e.id);
        applyPositions(d, e.positions);
        fx.push({ kind: 'task-deleted', id: e.id });
        break;
      case 'comment.created':
      case 'comment.deleted': {
        const t = d.tasks.find((x) => x.id === e.taskId);
        if (t) t.commentCount = e.commentCount;
        fx.push(evt.type === 'comment.created' ? { kind: 'comment', taskId: e.taskId, comment: e.comment } : { kind: 'comment', taskId: e.taskId, deletedId: e.id });
        break;
      }
      case 'column.created':
        if (!d.columns.some((c) => c.id === e.column.id)) d.columns.push(Object.assign({}, e.column));
        sortCols(d); fx.push({ kind: 'columns' });
        break;
      case 'column.updated': {
        const c = d.columns.find((x) => x.id === e.column.id);
        if (c) Object.assign(c, e.column);
        fx.push({ kind: 'columns' });
        break;
      }
      case 'column.deleted':
        d.columns = d.columns.filter((c) => c.id !== e.id);
        d.tasks = d.tasks.filter((t) => t.columnId !== e.id);
        (e.taskIds || []).forEach((id) => fx.push({ kind: 'task-deleted', id }));
        fx.push({ kind: 'columns' });
        break;
      case 'member.added':
        d.members = e.members; fx.push({ kind: 'members' });
        break;
      case 'member.removed':
        d.members = e.members;
        (e.unassigned || []).forEach((id) => { const t = d.tasks.find((x) => x.id === id); if (t) { t.assigneeId = null; t.rev = (t.rev || 1) + 1; } });
        fx.push({ kind: 'members', removedUserId: e.userId }, { kind: 'tasks' });
        break;
      case 'board.updated':
        Object.assign(d.board, e.board); fx.push({ kind: 'board' });
        break;
      default: break; // unknown event types are skipped but the version still advances
    }
    return { status: 'applied', effects: fx };
  }

  return { apply };
});
