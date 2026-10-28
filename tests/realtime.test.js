'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot, sleep } = require('./helpers');

async function board(s, names) {
  const users = {};
  for (const n of names) users[n] = await s.user(n);
  const a = users[names[0]];
  const b = (await a('POST', '/api/boards', { name: 'Live' })).body;
  for (const n of names.slice(1)) await a('POST', '/api/boards/' + b.board.id + '/members', { email: n + '@example.com' });
  return { users, a, b, id: b.board.id, col: b.columns[0].id, col2: b.columns[1].id };
}
const ver = async (c, id) => (await c('GET', '/api/boards/' + id + '/version')).body.version;

/* ---------- connecting ---------- */
test('sse: needs a login and board membership', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, id } = await board(s, ['ann']);
  const stranger = await s.user('zed');
  const anon = s.client();
  assert.equal((await s.stream(anon, '/api/boards/' + id + '/events')).status, 401);
  assert.equal((await s.stream(stranger, '/api/boards/' + id + '/events')).status, 404);
  const ok = await s.stream(a, '/api/boards/' + id + '/events');
  assert.equal(ok.status, 200);
  const hello = await ok.waitFor((e) => e.event === 'hello');
  assert.ok(hello.data.connId); assert.equal(hello.data.version, await ver(a, id));
  ok.abort();
});

test('sse: a change made by one user reaches the other user instantly, with the version as the event id', async (t) => {
  const s = await boot(); t.after(s.close);
  const { users, a, id, col, col2 } = await board(s, ['ann', 'bob']);
  const bob = users.bob;
  const st = await s.stream(bob, '/api/boards/' + id + '/events');
  await st.waitFor((e) => e.event === 'hello');
  const made = await a('POST', '/api/columns/' + col + '/tasks', { title: 'Live task' }, { 'X-Client-Id': 'tab-ann-0001' });
  const ev = await st.waitFor((e) => e.event === 'task.created');
  assert.equal(ev.data.data.task.title, 'Live task');
  assert.equal(ev.id, String(await ver(a, id)), 'SSE id equals the board version');
  assert.equal(ev.data.origin, 'tab-ann-0001', 'origin tab is passed on');
  assert.equal(ev.data.by, a.id);
  await a('POST', '/api/tasks/' + made.body.task.id + '/move', { columnId: col2, index: 0 });
  const mv = await st.waitFor((e) => e.event === 'task.moved');
  assert.equal(mv.data.data.task.columnId, col2);
  assert.ok(mv.data.data.positions.length >= 1);
  await a('POST', '/api/tasks/' + made.body.task.id + '/comments', { body: 'hi' });
  assert.equal((await st.waitFor((e) => e.event === 'comment.created')).data.data.commentCount, 1);
  await a('DELETE', '/api/tasks/' + made.body.task.id);
  await st.waitFor((e) => e.event === 'task.deleted');
  // versions are consecutive: no gaps in what a connected client sees
  const ids = st.events.filter((e) => e.id).map((e) => Number(e.id));
  ids.forEach((v, i) => { if (i) assert.equal(v, ids[i - 1] + 1); });
  st.abort();
});

test('sse: events never leak to other boards or to non-members', async (t) => {
  const s = await boot(); t.after(s.close);
  const one = await board(s, ['ann']);
  const bob = await s.user('bob');
  const other = (await bob('POST', '/api/boards', { name: 'Private' })).body;
  const st = await s.stream(bob, '/api/boards/' + other.board.id + '/events');
  await st.waitFor((e) => e.event === 'hello');
  await one.a('POST', '/api/columns/' + one.col + '/tasks', { title: 'Secret' });
  await sleep(150);
  assert.equal(st.events.filter((e) => e.event === 'task.created').length, 0);
  st.abort();
});

/* ---------- disconnects: replay, duplicates, resync ---------- */
test('reconnect: Last-Event-ID replays only the missed events, in order, once', async (t) => {
  const s = await boot(); t.after(s.close);
  const { users, a, id, col } = await board(s, ['ann', 'bob']);
  const bob = users.bob;
  const v0 = await ver(a, id);
  const first = await s.stream(bob, '/api/boards/' + id + '/events?since=' + v0);
  await first.waitFor((e) => e.event === 'hello');
  await a('POST', '/api/columns/' + col + '/tasks', { title: 'one' });
  await first.waitFor((e) => e.event === 'task.created');
  const lastSeen = await ver(a, id);
  first.abort();                                   // bob's connection drops...
  await sleep(50);
  await a('POST', '/api/columns/' + col + '/tasks', { title: 'two' });     // ...and things happen meanwhile
  await a('POST', '/api/columns/' + col + '/tasks', { title: 'three' });
  const again = await s.stream(bob, '/api/boards/' + id + '/events?since=' + v0, { 'Last-Event-ID': String(lastSeen) }); // header wins over the stale URL
  await again.waitFor((e) => e.data && e.data.data && e.data.data.task && e.data.data.task.title === 'three');
  const titles = again.of('task.created').map((e) => e.data.data.task.title);
  assert.deepEqual(titles, ['two', 'three'], 'missed events only, in order, and not "one" again');
  assert.equal(again.of('resync').length, 0);
  again.abort();
});

test('reconnect: when history is too old the server says resync', async (t) => {
  const s = await boot({ eventBuffer: 3 }); t.after(s.close);
  const { a, id, col } = await board(s, ['ann']);
  const v0 = await ver(a, id);
  for (let i = 0; i < 6; i++) await a('POST', '/api/columns/' + col + '/tasks', { title: 'x' + i });
  const st = await s.stream(a, '/api/boards/' + id + '/events', { 'Last-Event-ID': String(v0) });
  const r = await st.waitFor((e) => e.event === 'resync');
  assert.equal(r.data.version, await ver(a, id));
  assert.equal(st.of('task.created').length, 0, 'no partial replay when there is a hole');
  // a client that claims to be ahead of the server (e.g. after a server reset) is also told to resync
  const ahead = await s.stream(a, '/api/boards/' + id + '/events', { 'Last-Event-ID': '99999' });
  await ahead.waitFor((e) => e.event === 'resync');
  st.abort(); ahead.abort();
});

test('reconnect: an up-to-date client gets nothing replayed', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, id, col } = await board(s, ['ann']);
  await a('POST', '/api/columns/' + col + '/tasks', { title: 'x' });
  const st = await s.stream(a, '/api/boards/' + id + '/events', { 'Last-Event-ID': String(await ver(a, id)) });
  await st.waitFor((e) => e.event === 'presence');
  await sleep(80);
  assert.equal(st.events.filter((e) => e.id).length, 0);
  st.abort();
});

test('heartbeat: ping events keep the stream alive', async (t) => {
  const s = await boot({ heartbeatMs: 40 }); t.after(s.close);
  const { a, id } = await board(s, ['ann']);
  const st = await s.stream(a, '/api/boards/' + id + '/events');
  await st.waitFor((e) => e.event === 'ping', 1500);
  assert.equal(st.events.find((e) => e.event === 'ping').id, undefined, 'pings have no id, so they never disturb Last-Event-ID');
  st.abort();
});

/* ---------- who is online ---------- */
test('presence: join, several tabs count once, leave after a short grace period', async (t) => {
  const s = await boot({ graceMs: 120 }); t.after(s.close);
  const { users, a, id } = await board(s, ['ann', 'bob']);
  const bob = users.bob;
  const annStream = await s.stream(a, '/api/boards/' + id + '/events');
  const names = (p) => p.data.users.map((u) => u.name.split(' ')[0]).join(',');
  await annStream.waitFor((e) => e.event === 'presence' && names(e) === 'ann');
  const bob1 = await s.stream(bob, '/api/boards/' + id + '/events');
  await annStream.waitFor((e) => e.event === 'presence' && names(e) === 'ann,bob');
  const bob2 = await s.stream(bob, '/api/boards/' + id + '/events');        // second tab
  await sleep(60);
  const last = annStream.of('presence').pop();
  assert.equal(last.data.users.find((u) => u.name.startsWith('bob')).tabs, 2);
  assert.equal(last.data.users.length, 2, 'two tabs, one person');
  bob1.abort(); await sleep(250);
  assert.equal(annStream.of('presence').pop().data.users.length, 2, 'still online: the other tab is open');
  bob2.abort();
  await sleep(40);
  assert.equal(annStream.of('presence').pop().data.users.length, 2, 'grace period: a page refresh does not flicker');
  await annStream.waitFor((e) => e.event === 'presence' && names(e) === 'ann', 1500);
  annStream.abort();
});

test('presence: refresh within the grace period never shows the person as offline', async (t) => {
  const s = await boot({ graceMs: 300 }); t.after(s.close);
  const { users, a, id } = await board(s, ['ann', 'bob']);
  const watcher = await s.stream(a, '/api/boards/' + id + '/events');
  const b1 = await s.stream(users.bob, '/api/boards/' + id + '/events');
  await watcher.waitFor((e) => e.event === 'presence' && e.data.users.length === 2);
  const mark = watcher.events.length;
  b1.abort(); await sleep(60);
  const b2 = await s.stream(users.bob, '/api/boards/' + id + '/events');   // page reloaded
  await b2.waitFor((e) => e.event === 'hello');
  await sleep(450);                                                        // longer than the grace period
  const after = watcher.events.slice(mark).filter((e) => e.event === 'presence');
  assert.ok(after.length >= 1);
  assert.ok(after.every((p) => p.data.users.length === 2), 'Bob was never shown as offline');
  watcher.abort(); b2.abort();
});

test('presence: "editing" marker for an open task window, validated', async (t) => {
  const s = await boot(); t.after(s.close);
  const { users, a, id, col } = await board(s, ['ann', 'bob']);
  const task = (await a('POST', '/api/columns/' + col + '/tasks', { title: 'x' })).body.task;
  const watch = await s.stream(a, '/api/boards/' + id + '/events');
  const bobS = await s.stream(users.bob, '/api/boards/' + id + '/events');
  const hello = await bobS.waitFor((e) => e.event === 'hello');
  const r = await users.bob('POST', '/api/boards/' + id + '/presence', { connId: hello.data.connId, taskId: task.id });
  assert.equal(r.status, 200);
  await watch.waitFor((e) => e.event === 'presence' && e.data.users.some((u) => u.editing.includes(task.id)));
  await users.bob('POST', '/api/boards/' + id + '/presence', { connId: hello.data.connId, taskId: null });
  await watch.waitFor((e) => e.event === 'presence' && e.data.users.every((u) => u.editing.length === 0) && watch.of('presence').length > 2);
  // someone else's connection id, bad task id
  assert.equal((await a('POST', '/api/boards/' + id + '/presence', { connId: hello.data.connId, taskId: null })).status, 404);
  assert.equal((await users.bob('POST', '/api/boards/' + id + '/presence', { connId: hello.data.connId, taskId: 9999 })).status, 400);
  watch.abort(); bobS.abort();
});

/* ---------- membership changes close streams ---------- */
test('removed member: stream gets "removed" and is closed; deleted board: everyone is told', async (t) => {
  const s = await boot(); t.after(s.close);
  const { users, a, id } = await board(s, ['ann', 'bob', 'cat']);
  const bobS = await s.stream(users.bob, '/api/boards/' + id + '/events');
  const catS = await s.stream(users.cat, '/api/boards/' + id + '/events');
  await bobS.waitFor((e) => e.event === 'hello'); await catS.waitFor((e) => e.event === 'hello');
  await a('DELETE', '/api/boards/' + id + '/members/' + users.bob.id);
  await bobS.waitFor((e) => e.event === 'removed');
  await sleep(50); assert.equal(bobS.closed, true);
  assert.equal((await s.stream(users.bob, '/api/boards/' + id + '/events')).status, 404, 'and cannot reconnect');
  const rm = await catS.waitFor((e) => e.event === 'member.removed');
  assert.equal(rm.data.data.userId, users.bob.id);
  await a('DELETE', '/api/boards/' + id);
  await catS.waitFor((e) => e.event === 'board.deleted');
  await sleep(50); assert.equal(catS.closed, true);
  assert.equal(s.hub.connectionCount(), 0);
});

/* ---------- conflicting edits ---------- */
async function twoEditors(s) {
  const ctx = await board(s, ['ann', 'bob']);
  const task = (await ctx.a('POST', '/api/columns/' + ctx.col + '/tasks', { title: 'Original', description: 'd', priority: 'low' })).body.task;
  return Object.assign(ctx, { bob: ctx.users.bob, task });
}

test('conflicts: edits to DIFFERENT fields merge; the same field is a 409 that explains both sides', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, bob, task } = await twoEditors(s);
  const base = task.rev;                                  // both start from the same revision
  const r1 = await a('PATCH', '/api/tasks/' + task.id, { title: 'Ann title', baseRev: base });
  assert.equal(r1.status, 200); assert.equal(r1.body.task.rev, base + 1);
  const r2 = await bob('PATCH', '/api/tasks/' + task.id, { priority: 'high', baseRev: base });   // different field
  assert.equal(r2.status, 200);
  assert.equal(r2.body.task.title, 'Ann title', 'Ann\'s change is kept');
  assert.equal(r2.body.task.priority, 'high', 'Bob\'s change is applied too');
  const r3 = await bob('PATCH', '/api/tasks/' + task.id, { title: 'Bob title', description: 'new d', baseRev: base });  // title clashes
  assert.equal(r3.status, 409);
  assert.equal(r3.body.error.code, 'CONFLICT');
  assert.deepEqual(r3.body.error.conflicts, [{ field: 'title', yours: 'Bob title', theirs: 'Ann title', by: { id: a.id, name: 'ann Tester' } }], 'the conflict says WHO made the other change');
  assert.equal(r3.body.error.current.title, 'Ann title');
  assert.equal(r3.body.error.current.description, 'd', 'nothing was applied: all-or-nothing');
  // after seeing the latest, Bob can overwrite on purpose
  const r4 = await bob('PATCH', '/api/tasks/' + task.id, { title: 'Bob title', baseRev: r3.body.error.current.rev });
  assert.equal(r4.status, 200); assert.equal(r4.body.task.title, 'Bob title');
});

test('conflicts: a move by someone else does not block an unrelated edit; no baseRev = last writer wins', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, bob, task, col2 } = await twoEditors(s);
  const base = task.rev;
  await a('POST', '/api/tasks/' + task.id + '/move', { columnId: col2, index: 0 });
  const r = await bob('PATCH', '/api/tasks/' + task.id, { title: 'Edited after move', baseRev: base });
  assert.equal(r.status, 200);
  assert.equal(r.body.task.columnId, col2);
  const lww = await a('PATCH', '/api/tasks/' + task.id, { title: 'Ann wins', baseRev: undefined });
  assert.equal(lww.status, 200); assert.equal(lww.body.task.title, 'Ann wins');
  assert.equal((await a('PATCH', '/api/tasks/' + task.id, { title: 'x', baseRev: 0 })).status, 400);
});

test('conflicts: unchanged saves are no-ops (no new version, no event); edits to a deleted task are 404', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, bob, task, id } = await twoEditors(s);
  const v = await ver(a, id);
  const same = await a('PATCH', '/api/tasks/' + task.id, { title: 'Original', priority: 'low', baseRev: task.rev });
  assert.equal(same.status, 200); assert.equal(same.body.unchanged, true);
  assert.equal(await ver(a, id), v);
  await a('DELETE', '/api/tasks/' + task.id);
  assert.equal((await bob('PATCH', '/api/tasks/' + task.id, { title: 'ghost' })).status, 404);
});

test('conflicts: the update event carries rev and the changed field names', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, bob, task, id } = await twoEditors(s);
  const st = await s.stream(bob, '/api/boards/' + id + '/events');
  await st.waitFor((e) => e.event === 'hello');
  await a('PATCH', '/api/tasks/' + task.id, { title: 'N', priority: 'high' });
  const e = await st.waitFor((x) => x.event === 'task.updated');
  assert.deepEqual(e.data.data.changed.sort(), ['priority', 'title']);
  assert.equal(e.data.data.task.rev, task.rev + 1);
  st.abort();
});

/* ---------- duplicate requests ---------- */
test('idempotency: retrying a POST with the same key creates exactly one item and one event', async (t) => {
  const s = await boot(); t.after(s.close);
  const { a, id, col } = await board(s, ['ann']);
  const st = await s.stream(a, '/api/boards/' + id + '/events');
  await st.waitFor((e) => e.event === 'hello');
  const h = { 'Idempotency-Key': 'key-abc-12345' };
  const r1 = await a('POST', '/api/columns/' + col + '/tasks', { title: 'Once' }, h);
  const r2 = await a('POST', '/api/columns/' + col + '/tasks', { title: 'Once' }, h);
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);
  assert.equal(r2.headers.get('idempotent-replay'), 'true');
  assert.equal(r2.body.task.id, r1.body.task.id);
  assert.equal(s.store.data.tasks.length, 1);
  const c1 = await a('POST', '/api/tasks/' + r1.body.task.id + '/comments', { body: 'hello' }, { 'Idempotency-Key': 'key-comment-1' });
  const c2 = await a('POST', '/api/tasks/' + r1.body.task.id + '/comments', { body: 'hello' }, { 'Idempotency-Key': 'key-comment-1' });
  assert.equal(c1.body.comment.id, c2.body.comment.id);
  assert.equal(s.store.data.comments.length, 1);
  await sleep(100);
  assert.equal(st.of('task.created').length, 1, 'replayed requests do not publish a second event');
  assert.equal(st.of('comment.created').length, 1);
  // a different key is a different request; failed requests are not remembered
  assert.equal((await a('POST', '/api/columns/' + col + '/tasks', { title: 'Twice' }, { 'Idempotency-Key': 'key-other-9999' })).status, 201);
  const bad1 = await a('POST', '/api/columns/' + col + '/tasks', { title: '' }, { 'Idempotency-Key': 'key-fail-00001' });
  assert.equal(bad1.status, 400);
  assert.equal((await a('POST', '/api/columns/' + col + '/tasks', { title: 'Fixed' }, { 'Idempotency-Key': 'key-fail-00001' })).status, 201);
  assert.equal((await a('POST', '/api/columns/' + col + '/tasks', { title: 'x' }, { 'Idempotency-Key': 'bad key!' })).status, 400);
  st.abort();
});

test('idempotency: keys are per user (same key, different people, two items)', async (t) => {
  const s = await boot(); t.after(s.close);
  const { users, a, col } = await board(s, ['ann', 'bob']);
  const h = { 'Idempotency-Key': 'shared-key-123' };
  await a('POST', '/api/columns/' + col + '/tasks', { title: 'A' }, h);
  const r = await users.bob('POST', '/api/columns/' + col + '/tasks', { title: 'B' }, h);
  assert.equal(r.body.task.title, 'B');
  assert.equal(s.store.data.tasks.length, 2);
});
