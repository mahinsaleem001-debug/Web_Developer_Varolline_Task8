'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Sync = require('../public/js/sync.js');

const task = (id, over) => Object.assign({ id, columnId: 1, title: 'T' + id, position: id, rev: 1, commentCount: 0, assigneeId: null }, over);
const fresh = () => ({ version: 5, data: { board: { id: 1, version: 5 }, members: [], columns: [{ id: 1, name: 'To do', position: 1 }, { id: 2, name: 'Done', position: 2 }], tasks: [task(1), task(2)] } });
const ev = (id, type, data) => ({ id, type, data });

test('sync: duplicates are ignored, in-order events apply', () => {
  const s = fresh();
  const created = ev(6, 'task.created', { task: task(3) });
  assert.equal(Sync.apply(s, created).status, 'applied');
  assert.equal(s.data.tasks.length, 3);
  assert.equal(Sync.apply(s, created).status, 'duplicate', 'same event again');
  assert.equal(Sync.apply(s, ev(5, 'task.created', { task: task(9) })).status, 'duplicate', 'older event');
  assert.equal(s.data.tasks.length, 3);
  assert.equal(s.version, 6);
  assert.equal(s.data.board.version, 6);
});

test('sync: a gap is reported and nothing is changed', () => {
  const s = fresh();
  const r = Sync.apply(s, ev(8, 'task.created', { task: task(3) }));
  assert.equal(r.status, 'gap'); assert.equal(r.expected, 6);
  assert.equal(s.data.tasks.length, 2); assert.equal(s.version, 5);
});

test('sync: task.updated only wins with a higher rev (idempotent, order safe)', () => {
  const s = fresh();
  Sync.apply(s, ev(6, 'task.updated', { task: task(1, { title: 'New', rev: 3 }), changed: ['title'] }));
  assert.equal(s.data.tasks[0].title, 'New');
  const r = Sync.apply(s, ev(7, 'task.updated', { task: task(1, { title: 'Stale', rev: 2 }), changed: ['title'] }));
  assert.equal(s.data.tasks[0].title, 'New', 'older rev does not overwrite');
  assert.deepEqual(r.effects, []);
});

test('sync: move applies positions in both lists', () => {
  const s = fresh();
  Sync.apply(s, ev(6, 'task.moved', { task: task(1, { columnId: 2, rev: 2 }), positions: [{ id: 1, columnId: 2, position: 1 }, { id: 2, columnId: 1, position: 1 }] }));
  assert.equal(s.data.tasks.find((t) => t.id === 1).columnId, 2);
  assert.equal(s.data.tasks.find((t) => t.id === 2).position, 1);
});

test('sync: delete task, comments count, columns, members, board', () => {
  const s = fresh();
  Sync.apply(s, ev(6, 'comment.created', { comment: { id: 1 }, taskId: 2, commentCount: 4 }));
  assert.equal(s.data.tasks.find((t) => t.id === 2).commentCount, 4);
  const d = Sync.apply(s, ev(7, 'task.deleted', { id: 1, columnId: 1, positions: [{ id: 2, columnId: 1, position: 1 }] }));
  assert.deepEqual(d.effects, [{ kind: 'task-deleted', id: 1 }]);
  assert.equal(s.data.tasks.length, 1);
  Sync.apply(s, ev(8, 'column.created', { column: { id: 3, name: 'QA', position: 3 } }));
  assert.equal(s.data.columns.length, 3);
  Sync.apply(s, ev(9, 'column.deleted', { id: 1, taskIds: [2] }));
  assert.equal(s.data.tasks.length, 0); assert.equal(s.data.columns.length, 2);
  Sync.apply(s, ev(10, 'board.updated', { board: { id: 1, name: 'Renamed' } }));
  assert.equal(s.data.board.name, 'Renamed');
  Sync.apply(s, ev(11, 'member.added', { members: [{ id: 1 }, { id: 2 }] }));
  assert.equal(s.data.members.length, 2);
});

test('sync: member removal unassigns their tasks; unknown events still advance the version', () => {
  const s = fresh();
  s.data.tasks[0].assigneeId = 7;
  Sync.apply(s, ev(6, 'member.removed', { userId: 7, members: [], unassigned: [1] }));
  assert.equal(s.data.tasks[0].assigneeId, null);
  assert.equal(Sync.apply(s, ev(7, 'future.thing', {})).status, 'applied');
  assert.equal(s.version, 7);
});

test('sync: own echo while a request is in flight only advances the version', () => {
  const s = fresh();
  const r = Sync.apply(s, ev(6, 'task.created', { task: task(3) }), { skipApply: true });
  assert.equal(r.status, 'skipped'); assert.equal(s.data.tasks.length, 2); assert.equal(s.version, 6);
});
