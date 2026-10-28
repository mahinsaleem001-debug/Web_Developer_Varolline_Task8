'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/app');
const { Store } = require('../server/db');

async function boot(opts) {
  const store = (opts && opts.store) || new Store(null);
  const app = createApp(Object.assign({ store, bcryptCost: 4, secret: 'test-secret', authLimit: 1000 }, opts));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    let cookie = '';
    return async function call(method, url, body, headers) {
      const res = await fetch(base + url, {
        method,
        headers: Object.assign({ 'Content-Type': 'application/json', 'X-Requested-With': 'taskflow', Cookie: cookie }, headers),
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const sc = res.headers.get('set-cookie');
      if (sc) cookie = sc.split(';')[0];
      let json = null; try { json = await res.json(); } catch (e) { /* no body */ }
      return { status: res.status, body: json, headers: res.headers };
    };
  }
  async function user(name) {
    const c = client();
    const r = await c('POST', '/api/auth/signup', { name: name + ' Tester', email: name + '@example.com', password: 'Passw0rdX' });
    assert.equal(r.status, 201);
    c.id = r.body.user.id; c.email = name + '@example.com';
    return c;
  }
  return { store, server, base, client, user, close: () => server.close() };
}

/* ---------- accounts and sessions ---------- */
test('auth: signup, me, logout, login', async (t) => {
  const s = await boot(); t.after(s.close);
  const c = s.client();
  assert.equal((await c('GET', '/api/auth/me')).status, 401);
  const up = await c('POST', '/api/auth/signup', { name: 'Ada Lovelace', email: 'ADA@Example.com', password: 'Passw0rdX' });
  assert.equal(up.status, 201);
  assert.equal(up.body.user.email, 'ada@example.com');
  assert.equal(up.body.user.passwordHash, undefined, 'hash is never returned');
  assert.match(up.headers.get('set-cookie'), /HttpOnly/i);
  assert.match(up.headers.get('set-cookie'), /SameSite=Strict/i);
  assert.equal((await c('GET', '/api/auth/me')).body.user.name, 'Ada Lovelace');
  await c('POST', '/api/auth/logout', {});
  const c2 = s.client();
  assert.equal((await c2('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrong-pass1' })).status, 401);
  assert.equal((await c2('POST', '/api/auth/login', { email: 'ada@example.com', password: 'Passw0rdX' })).status, 200);
  assert.equal((await c2('GET', '/api/auth/me')).status, 200);
});

test('auth: validation, duplicate email, password is hashed', async (t) => {
  const s = await boot(); t.after(s.close);
  const c = s.client();
  const r = await c('POST', '/api/auth/signup', { name: 'A', email: 'nope', password: 'short' });
  assert.equal(r.status, 400);
  assert.ok(r.body.error.fields.name && r.body.error.fields.email && r.body.error.fields.password);
  await s.user('dup');
  const again = await c('POST', '/api/auth/signup', { name: 'Dup Two', email: 'dup@example.com', password: 'Passw0rdX' });
  assert.equal(again.status, 409);
  const stored = s.store.data.users[0];
  assert.notEqual(stored.passwordHash, 'Passw0rdX');
  assert.match(stored.passwordHash, /^\$2[aby]\$/);
});

test('security: writes without the CSRF header are rejected; tampered token is rejected; rate limit works', async (t) => {
  const s = await boot(); t.after(s.close);
  const raw = await fetch(s.base + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(raw.status, 403);
  const c = s.client();
  await c('POST', '/api/auth/signup', { name: 'Eve Test', email: 'eve@example.com', password: 'Passw0rdX' });
  const forged = await fetch(s.base + '/api/boards', { headers: { Cookie: 'tf_token=abc.def.ghi' } });
  assert.equal(forged.status, 401);
  const lim = await boot({ authLimit: 3 }); t.after(lim.close);
  const lc = lim.client(); let last;
  for (let i = 0; i < 4; i++) last = await lc('POST', '/api/auth/login', { email: 'x@example.com', password: 'whatever1' });
  assert.equal(last.status, 429);
});

test('api: unauthenticated requests get 401; unknown API routes get 404 JSON', async (t) => {
  const s = await boot(); t.after(s.close);
  const c = s.client();
  assert.equal((await c('GET', '/api/boards')).status, 401);
  assert.equal((await c('POST', '/api/boards', { name: 'x' })).status, 401);
  const nf = await c('GET', '/api/nothing-here');
  assert.equal(nf.status, 404); assert.equal(nf.body.error.code, 'NOT_FOUND');
  const badJson = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'taskflow' }, body: '{oops' });
  assert.equal(badJson.status, 400);
});

/* ---------- boards, lists, tasks ---------- */
async function setup(s) {
  const a = await s.user('alice'), b = await s.user('bob'), c = await s.user('carol');
  const created = await a('POST', '/api/boards', { name: 'Launch', description: 'Ship it' });
  assert.equal(created.status, 201);
  return { a, b, c, board: created.body };
}

test('boards: create gives 3 default lists; validation; owner can rename', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  assert.deepEqual(board.columns.map((c) => c.name), ['To do', 'In progress', 'Done']);
  assert.equal(board.role, 'owner');
  assert.equal((await a('POST', '/api/boards', { name: '   ' })).status, 400);
  const r = await a('PATCH', '/api/boards/' + board.board.id, { name: 'Launch v2' });
  assert.equal(r.body.board.name, 'Launch v2');
  const list = await a('GET', '/api/boards');
  assert.equal(list.body.boards.length, 1);
});

test('permissions: non-members cannot see or touch anything on a board (404)', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, b, board } = await setup(s);
  const id = board.board.id, col = board.columns[0].id;
  const task = (await a('POST', '/api/columns/' + col + '/tasks', { title: 'Secret task' })).body.task;
  const cm = (await a('POST', '/api/tasks/' + task.id + '/comments', { body: 'secret comment' })).body.comment;

  assert.equal((await b('GET', '/api/boards')).body.boards.length, 0);
  const attempts = [
    ['GET', '/api/boards/' + id], ['GET', '/api/boards/' + id + '/version'], ['PATCH', '/api/boards/' + id, { name: 'hax' }],
    ['DELETE', '/api/boards/' + id], ['POST', '/api/boards/' + id + '/columns', { name: 'x' }],
    ['PATCH', '/api/columns/' + col, { name: 'x' }], ['DELETE', '/api/columns/' + col],
    ['POST', '/api/columns/' + col + '/tasks', { title: 'x' }], ['GET', '/api/tasks/' + task.id],
    ['PATCH', '/api/tasks/' + task.id, { title: 'x' }], ['POST', '/api/tasks/' + task.id + '/move', { columnId: col, index: 0 }],
    ['DELETE', '/api/tasks/' + task.id], ['POST', '/api/tasks/' + task.id + '/comments', { body: 'x' }],
    ['DELETE', '/api/comments/' + cm.id], ['POST', '/api/boards/' + id + '/members', { email: 'bob@example.com' }]
  ];
  for (const [m, u, body] of attempts) {
    const r = await b(m, u, body);
    assert.equal(r.status, 404, m + ' ' + u + ' should be 404 for a non-member, got ' + r.status);
  }
  assert.equal(s.store.data.tasks.length, 1, 'nothing was changed');
});

test('members: owner invites by email; member sees board; roles enforced; leaving unassigns tasks', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, b, c, board } = await setup(s);
  const id = board.board.id, col = board.columns[0].id;
  assert.equal((await a('POST', '/api/boards/' + id + '/members', { email: 'nobody@example.com' })).status, 404);
  const inv = await a('POST', '/api/boards/' + id + '/members', { email: 'bob@example.com' });
  assert.equal(inv.status, 201);
  assert.equal((await a('POST', '/api/boards/' + id + '/members', { email: 'bob@example.com' })).status, 409);
  const seen = await b('GET', '/api/boards/' + id);
  assert.equal(seen.status, 200); assert.equal(seen.body.role, 'member');
  assert.equal(seen.body.members.length, 2);
  // members cannot invite, rename or delete
  assert.equal((await b('POST', '/api/boards/' + id + '/members', { email: 'carol@example.com' })).status, 403);
  assert.equal((await b('PATCH', '/api/boards/' + id, { name: 'x' })).status, 403);
  assert.equal((await b('DELETE', '/api/boards/' + id)).status, 403);
  // assignee must be a member
  assert.equal((await a('POST', '/api/columns/' + col + '/tasks', { title: 'T', assigneeId: c.id })).status, 400);
  const t1 = (await a('POST', '/api/columns/' + col + '/tasks', { title: 'T', assigneeId: b.id })).body.task;
  assert.equal(t1.assigneeId, b.id);
  // bob leaves -> his tasks become unassigned; owner cannot leave
  assert.equal((await b('DELETE', '/api/boards/' + id + '/members/' + b.id)).status, 200);
  assert.equal((await b('GET', '/api/boards/' + id)).status, 404);
  assert.equal((await a('GET', '/api/tasks/' + t1.id)).body.task.assigneeId, null);
  assert.equal((await a('DELETE', '/api/boards/' + id + '/members/' + a.id)).status, 400);
});

test('tasks: create, validate, update, delete', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  const col = board.columns[0].id;
  const bad1 = await a('POST', '/api/columns/' + col + '/tasks', { title: '', priority: 'urgent', due: '2026-02-31' });
  assert.equal(bad1.status, 400);
  assert.ok(bad1.body.error.fields.title && bad1.body.error.fields.priority && bad1.body.error.fields.due);
  const ok = await a('POST', '/api/columns/' + col + '/tasks', { title: '  Write docs  ', priority: 'high', due: '2026-12-01', description: 'Hello' });
  assert.equal(ok.status, 201); assert.equal(ok.body.task.title, 'Write docs');
  const up = await a('PATCH', '/api/tasks/' + ok.body.task.id, { priority: 'low', due: null });
  assert.equal(up.body.task.priority, 'low'); assert.equal(up.body.task.due, null); assert.equal(up.body.task.title, 'Write docs');
  assert.equal((await a('PATCH', '/api/tasks/' + ok.body.task.id, { title: 'x'.repeat(200) })).status, 400);
  assert.equal((await a('DELETE', '/api/tasks/' + ok.body.task.id)).status, 200);
  assert.equal((await a('GET', '/api/tasks/' + ok.body.task.id)).status, 404);
  assert.equal((await a('GET', '/api/tasks/abc')).status, 404);
});

test('move: reorders inside a list and between lists, keeping positions 1..n', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  const [todo, doing] = board.columns;
  const mk = async (title) => (await a('POST', '/api/columns/' + todo.id + '/tasks', { title })).body.task;
  const [t1, t2, t3] = [await mk('one'), await mk('two'), await mk('three')];
  const titles = async (col) => (await a('GET', '/api/boards/' + board.board.id)).body.tasks.filter((x) => x.columnId === col).sort((x, y) => x.position - y.position).map((x) => x.title + ':' + x.position);
  await a('POST', '/api/tasks/' + t3.id + '/move', { columnId: todo.id, index: 0 });
  assert.deepEqual(await titles(todo.id), ['three:1', 'one:2', 'two:3']);
  await a('POST', '/api/tasks/' + t1.id + '/move', { columnId: doing.id, index: 0 });
  assert.deepEqual(await titles(todo.id), ['three:1', 'two:2']);
  assert.deepEqual(await titles(doing.id), ['one:1']);
  await a('POST', '/api/tasks/' + t2.id + '/move', { columnId: doing.id, index: 99 });
  assert.deepEqual(await titles(doing.id), ['one:1', 'two:2'], 'index past the end goes last');
  assert.equal((await a('POST', '/api/tasks/' + t2.id + '/move', { columnId: 9999, index: 0 })).status, 400);
  assert.equal((await a('POST', '/api/tasks/' + t2.id + '/move', { columnId: doing.id, index: -1 })).status, 400);
});

test('move: cannot move a task into a list of another board', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  const other = (await a('POST', '/api/boards', { name: 'Other' })).body;
  const task = (await a('POST', '/api/columns/' + board.columns[0].id + '/tasks', { title: 'x' })).body.task;
  const r = await a('POST', '/api/tasks/' + task.id + '/move', { columnId: other.columns[0].id, index: 0 });
  assert.equal(r.status, 400);
});

test('lists: add, rename, delete (removes its tasks and comments)', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  const id = board.board.id;
  const col = (await a('POST', '/api/boards/' + id + '/columns', { name: 'Review' })).body.column;
  assert.equal(col.position, 4);
  assert.equal((await a('POST', '/api/boards/' + id + '/columns', { name: '' })).status, 400);
  assert.equal((await a('PATCH', '/api/columns/' + col.id, { name: 'QA' })).body.column.name, 'QA');
  const task = (await a('POST', '/api/columns/' + col.id + '/tasks', { title: 'x' })).body.task;
  await a('POST', '/api/tasks/' + task.id + '/comments', { body: 'hi' });
  assert.equal((await a('DELETE', '/api/columns/' + col.id)).status, 200);
  assert.equal(s.store.data.tasks.length, 0);
  assert.equal(s.store.data.comments.length, 0);
});

test('comments: add, list with author, validation, delete rules', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, b, board } = await setup(s);
  const id = board.board.id;
  await a('POST', '/api/boards/' + id + '/members', { email: 'bob@example.com' });
  const task = (await a('POST', '/api/columns/' + board.columns[0].id + '/tasks', { title: 'x' })).body.task;
  assert.equal((await b('POST', '/api/tasks/' + task.id + '/comments', { body: '   ' })).status, 400);
  const c1 = (await b('POST', '/api/tasks/' + task.id + '/comments', { body: '<b>hi</b>' })).body.comment;
  assert.equal(c1.body, '<b>hi</b>', 'stored as plain text (the UI renders with textContent)');
  assert.equal(c1.author.name, 'bob Tester');
  const got = (await a('GET', '/api/tasks/' + task.id)).body;
  assert.equal(got.comments.length, 1); assert.equal(got.task.commentCount, 1);
  const c2 = (await a('POST', '/api/tasks/' + task.id + '/comments', { body: 'owner note' })).body.comment;
  assert.equal((await b('DELETE', '/api/comments/' + c2.id)).status, 403, 'member cannot delete someone else\'s comment');
  assert.equal((await a('DELETE', '/api/comments/' + c1.id)).status, 200, 'owner can delete any comment');
  assert.equal((await a('DELETE', '/api/comments/' + c2.id)).status, 200);
});

test('version: increases on every change so clients can poll cheaply', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  const id = board.board.id;
  const v0 = (await a('GET', '/api/boards/' + id + '/version')).body.version;
  await a('POST', '/api/columns/' + board.columns[0].id + '/tasks', { title: 'x' });
  const v1 = (await a('GET', '/api/boards/' + id + '/version')).body.version;
  assert.ok(v1 > v0);
  assert.equal((await a('GET', '/api/boards/' + id + '/version')).body.version, v1, 'reading does not change it');
});

test('delete board removes everything that belongs to it', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, board } = await setup(s);
  const task = (await a('POST', '/api/columns/' + board.columns[0].id + '/tasks', { title: 'x' })).body.task;
  await a('POST', '/api/tasks/' + task.id + '/comments', { body: 'c' });
  assert.equal((await a('DELETE', '/api/boards/' + board.board.id)).status, 200);
  const d = s.store.data;
  assert.equal(d.boards.length + d.columns.length + d.tasks.length + d.comments.length + d.members.length, 0);
});

test('database: data survives a restart (JSON file, atomic write)', async (t) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tf-')), 'db.json');
  const s1 = await boot({ store: new Store(file) });
  const a = await s1.user('persist');
  const b = (await a('POST', '/api/boards', { name: 'Keep me' })).body;
  s1.close();
  const s2 = await boot({ store: new Store(file) }); t.after(s2.close);
  const c = s2.client();
  assert.equal((await c('POST', '/api/auth/login', { email: 'persist@example.com', password: 'Passw0rdX' })).status, 200);
  const list = await c('GET', '/api/boards');
  assert.equal(list.body.boards[0].name, 'Keep me');
  assert.equal(list.body.boards[0].id, b.board.id);
  const next = (await c('POST', '/api/boards', { name: 'Second' })).body;
  assert.ok(next.board.id > b.board.id, 'ids keep counting up after a restart');
  assert.ok(!fs.existsSync(file + '.tmp'), 'no leftover temp file');
});
