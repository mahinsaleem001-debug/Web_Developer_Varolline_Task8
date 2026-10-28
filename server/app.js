'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const V = require('../public/js/validate.js');
const { Store } = require('./db');
const { Hub } = require('./hub');

const COOKIE = 'tf_token';
const CSRF_HEADER = 'taskflow'; // value required in X-Requested-With on every write request
const now = () => new Date().toISOString();

class HttpError extends Error {
  constructor(status, code, message, fields, extra) { super(message); this.status = status; this.code = code; this.fields = fields; this.extra = extra; }
}
const bad = (fields, message) => new HttpError(400, 'VALIDATION', message || 'Please fix the highlighted fields.', fields);
const toId = (v) => (/^\d{1,9}$/.test(String(v)) && Number(v) > 0 ? Number(v) : null);

function createApp(opts) {
  const o = opts || {};
  const store = o.store || new Store(null);
  const d = store.data;
  const secret = o.secret || process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
  const cost = o.bcryptCost || Number(process.env.BCRYPT_COST) || 10;
  const authLimit = o.authLimit || 30;           // login/signup attempts per minute per IP
  const secureCookie = process.env.NODE_ENV === 'production';
  const dummyHash = bcrypt.hashSync('not-a-real-password-1', cost);

  const hub = o.hub || new Hub({ bufferSize: o.eventBuffer, heartbeatMs: o.heartbeatMs, graceMs: o.graceMs });
  const app = express();
  app.hub = hub;
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  /* ---------- security headers ---------- */
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      'Cache-Control': req.path.startsWith('/api/') ? 'no-store' : 'no-cache'
    });
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  /* ---------- CSRF: writes must carry a custom header (cross-site forms/fetches cannot add it) ---------- */
  app.use('/api', (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.get('x-requested-with') !== CSRF_HEADER) return next(new HttpError(403, 'CSRF', 'Missing security header.'));
    next();
  });

  /* ---------- tiny rate limiter for login/signup ---------- */
  const hits = new Map();
  function limiter(req, res, next) {
    const key = req.ip;
    const t = Date.now();
    const rec = (hits.get(key) || []).filter((x) => t - x < 60000);
    if (rec.length >= authLimit) {
      res.set('Retry-After', '60');
      return next(new HttpError(429, 'RATE_LIMIT', 'Too many attempts. Please wait a minute and try again.'));
    }
    rec.push(t); hits.set(key, rec);
    next();
  }

  /* ---------- auth ---------- */
  const pub = (u) => ({ id: u.id, name: u.name, email: u.email });
  function readCookie(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }
  function setSession(res, user) {
    const token = jwt.sign({ sub: user.id }, secret, { algorithm: 'HS256', expiresIn: '7d' });
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie, maxAge: 7 * 24 * 3600 * 1000, path: '/' });
  }
  function auth(req, res, next) {
    const token = readCookie(req, COOKIE);
    if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Please log in.'));
    try {
      const p = jwt.verify(token, secret, { algorithms: ['HS256'] });
      const user = d.users.find((u) => u.id === p.sub);
      if (!user) throw new Error('no user');
      req.user = user;
      next();
    } catch (e) { next(new HttpError(401, 'UNAUTHENTICATED', 'Your session has expired. Please log in again.')); }
  }
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.post('/api/auth/signup', limiter, wrap(async (req, res) => {
    const v = V.signup(req.body || {});
    if (!v.ok) throw bad(v.errors);
    if (d.users.some((u) => u.email === v.value.email)) throw new HttpError(409, 'EMAIL_TAKEN', 'An account with this email already exists.', { email: 'An account with this email already exists.' });
    const user = { id: store.nextId('users'), name: v.value.name, email: v.value.email, passwordHash: await bcrypt.hash(v.value.password, cost), createdAt: now() };
    d.users.push(user); store.save();
    setSession(res, user);
    res.status(201).json({ user: pub(user) });
  }));

  app.post('/api/auth/login', limiter, wrap(async (req, res) => {
    const v = V.login(req.body || {});
    if (!v.ok) throw bad(v.errors);
    const user = d.users.find((u) => u.email === v.value.email);
    const okPw = await bcrypt.compare(v.value.password, user ? user.passwordHash : dummyHash); // same work either way
    if (!user || !okPw) throw new HttpError(401, 'BAD_CREDENTIALS', 'Invalid email or password.');
    setSession(res, user);
    res.json({ user: pub(user) });
  }));

  app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(COOKIE, { path: '/', sameSite: 'strict', httpOnly: true, secure: secureCookie });
    res.json({ ok: true });
  });

  app.get('/api/auth/me', auth, (req, res) => res.json({ user: pub(req.user) }));

  /* ---------- permission helpers: non-members get 404, so board ids are not even confirmed to exist ---------- */
  const membership = (boardId, userId) => d.members.find((m) => m.boardId === boardId && m.userId === userId);
  function needBoard(req, rawId, ownerOnly) {
    const id = toId(rawId);
    const m = id && membership(id, req.user.id);
    const board = m && d.boards.find((b) => b.id === id);
    if (!board) throw new HttpError(404, 'NOT_FOUND', 'Board not found.');
    if (ownerOnly && m.role !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Only the board owner can do this.');
    return { board, me: m };
  }
  function needColumn(req, rawId) {
    const id = toId(rawId);
    const column = id && d.columns.find((c) => c.id === id);
    if (!column) throw new HttpError(404, 'NOT_FOUND', 'List not found.');
    return Object.assign({ column }, needBoard(req, column.boardId));
  }
  function needTask(req, rawId) {
    const id = toId(rawId);
    const task = id && d.tasks.find((t) => t.id === id);
    if (!task) throw new HttpError(404, 'NOT_FOUND', 'Task not found.');
    return Object.assign({ task }, needBoard(req, task.boardId));
  }
  // Every change bumps the board version and is published to everyone watching the board.
  // The version is the SSE event id, so clients can detect gaps, duplicates and old events.
  // (`origin` is the id of the browser tab that made the change, so that tab can recognise its own echo.)
  const originOf = (req) => { const v = req.get('x-client-id'); return v && /^[A-Za-z0-9_-]{6,40}$/.test(v) ? v : null; };
  function commit(board, req, res, type, data) {
    board.version += 1; board.updatedAt = now(); store.save();
    res.set({ 'X-Board-Id': String(board.id), 'X-Board-Version': String(board.version) });
    hub.publish(board.id, { id: board.version, type, by: req.user.id, origin: originOf(req), data });
  }

  /* ---------- Idempotency-Key: a retried POST (after a timeout) must not create a second copy ---------- */
  const idemStore = new Map();
  function idem(req, res, next) {
    const key = req.get('idempotency-key');
    if (!key) return next();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) return next(new HttpError(400, 'BAD_IDEMPOTENCY_KEY', 'Idempotency-Key must be 8-64 letters, digits, - or _.'));
    const k = req.user.id + ':' + key;
    const t = Date.now();
    if (idemStore.size > 2000) idemStore.forEach((v, kk) => { if (t - v.at > 600000) idemStore.delete(kk); });
    const hit = idemStore.get(k);
    if (hit && t - hit.at < 600000) { res.set('Idempotent-Replay', 'true'); return res.status(hit.status).json(hit.body); }
    const json = res.json.bind(res);
    res.json = (body) => { if (res.statusCode < 400) idemStore.set(k, { at: Date.now(), status: res.statusCode, body }); return json(body); };
    next();
  }
  const byPos = (a, b) => a.position - b.position || a.id - b.id;
  const inColumn = (colId) => d.tasks.filter((t) => t.columnId === colId).sort(byPos);
  const reindex = (list) => list.forEach((t, i) => { t.position = i + 1; });

  function membersOf(boardId) {
    return d.members.filter((m) => m.boardId === boardId).map((m) => {
      const u = d.users.find((x) => x.id === m.userId);
      return { id: u.id, name: u.name, email: u.email, role: m.role };
    });
  }
  const taskOut = (t) => ({
    id: t.id, boardId: t.boardId, columnId: t.columnId, title: t.title, description: t.description,
    priority: t.priority, due: t.due, assigneeId: t.assigneeId, position: t.position, rev: t.rev || 1,
    commentCount: d.comments.filter((c) => c.taskId === t.id).length, createdAt: t.createdAt, updatedAt: t.updatedAt
  });
  const commentOut = (c) => {
    const u = d.users.find((x) => x.id === c.authorId);
    return { id: c.id, taskId: c.taskId, body: c.body, createdAt: c.createdAt, author: u ? { id: u.id, name: u.name } : { id: 0, name: 'Deleted user' } };
  };
  function boardOut(board, me) {
    return {
      board: { id: board.id, name: board.name, description: board.description, ownerId: board.ownerId, version: board.version, updatedAt: board.updatedAt },
      role: me.role,
      members: membersOf(board.id),
      columns: d.columns.filter((c) => c.boardId === board.id).sort(byPos).map((c) => ({ id: c.id, name: c.name, position: c.position })),
      tasks: d.tasks.filter((t) => t.boardId === board.id).sort(byPos).map(taskOut)
    };
  }
  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  /* ---------- boards ---------- */
  app.get('/api/boards', auth, (req, res) => {
    const list = d.members.filter((m) => m.userId === req.user.id).map((m) => {
      const b = d.boards.find((x) => x.id === m.boardId);
      return {
        id: b.id, name: b.name, description: b.description, role: m.role, updatedAt: b.updatedAt,
        memberCount: d.members.filter((x) => x.boardId === b.id).length,
        taskCount: d.tasks.filter((t) => t.boardId === b.id).length
      };
    }).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    res.json({ boards: list });
  });

  app.post('/api/boards', auth, idem, (req, res) => {
    const v = V.board(body(req));
    if (!v.ok) throw bad(v.errors);
    const t = now();
    const board = { id: store.nextId('boards'), name: v.value.name, description: v.value.description, ownerId: req.user.id, version: 1, createdAt: t, updatedAt: t };
    d.boards.push(board);
    const me = { id: store.nextId('members'), boardId: board.id, userId: req.user.id, role: 'owner' };
    d.members.push(me);
    ['To do', 'In progress', 'Done'].forEach((name, i) => d.columns.push({ id: store.nextId('columns'), boardId: board.id, name, position: i + 1 }));
    store.save();
    res.status(201).json(boardOut(board, me));
  });

  app.get('/api/boards/:id', auth, (req, res) => {
    const { board, me } = needBoard(req, req.params.id);
    res.json(boardOut(board, me));
  });

  // Very small response used for polling: has anything changed?
  app.get('/api/boards/:id/version', auth, (req, res) => {
    const { board } = needBoard(req, req.params.id);
    res.json({ version: board.version });
  });

  app.patch('/api/boards/:id', auth, (req, res) => {
    const { board } = needBoard(req, req.params.id, true);
    const v = V.board(Object.assign({ name: board.name, description: board.description }, body(req)));
    if (!v.ok) throw bad(v.errors);
    board.name = v.value.name; board.description = v.value.description;
    commit(board, req, res, 'board.updated', { board: { id: board.id, name: board.name, description: board.description } });
    res.json({ board: { id: board.id, name: board.name, description: board.description, version: board.version } });
  });

  app.delete('/api/boards/:id', auth, (req, res) => {
    const { board } = needBoard(req, req.params.id, true);
    const taskIds = new Set(d.tasks.filter((t) => t.boardId === board.id).map((t) => t.id));
    d.comments = d.comments.filter((c) => !taskIds.has(c.taskId));
    d.tasks = d.tasks.filter((t) => t.boardId !== board.id);
    d.columns = d.columns.filter((c) => c.boardId !== board.id);
    d.members = d.members.filter((m) => m.boardId !== board.id);
    d.boards = d.boards.filter((b) => b.id !== board.id);
    store.save();
    hub.closeBoard(board.id, 'board.deleted', { boardId: board.id });
    res.json({ ok: true });
  });

  /* ---------- members ---------- */
  app.post('/api/boards/:id/members', auth, (req, res) => {
    const { board } = needBoard(req, req.params.id, true);
    const v = V.member(body(req));
    if (!v.ok) throw bad(v.errors);
    const user = d.users.find((u) => u.email === v.value.email);
    if (!user) throw new HttpError(404, 'NO_SUCH_USER', 'No account with that email. Ask them to sign up first.', { email: 'No account with that email. Ask them to sign up first.' });
    if (membership(board.id, user.id)) throw new HttpError(409, 'ALREADY_MEMBER', 'That person is already on this board.', { email: 'That person is already on this board.' });
    d.members.push({ id: store.nextId('members'), boardId: board.id, userId: user.id, role: 'member' });
    commit(board, req, res, 'member.added', { members: membersOf(board.id) });
    res.status(201).json({ members: membersOf(board.id) });
  });

  app.delete('/api/boards/:id/members/:userId', auth, (req, res) => {
    const { board, me } = needBoard(req, req.params.id);
    const uid = toId(req.params.userId);
    const target = uid && membership(board.id, uid);
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'Member not found.');
    if (uid !== req.user.id && me.role !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'Only the board owner can remove other people.');
    if (target.role === 'owner') throw new HttpError(400, 'OWNER_CANNOT_LEAVE', 'The owner cannot leave. Delete the board instead.');
    d.members = d.members.filter((m) => m !== target);
    const unassigned = [];
    d.tasks.forEach((t) => { if (t.boardId === board.id && t.assigneeId === uid) { t.assigneeId = null; t.rev = (t.rev || 1) + 1; unassigned.push(t.id); } });
    commit(board, req, res, 'member.removed', { userId: uid, members: membersOf(board.id), unassigned });
    hub.closeUser(board.id, uid, 'removed', { boardId: board.id });
    res.json({ ok: true });
  });

  /* ---------- lists (columns) ---------- */
  app.post('/api/boards/:id/columns', auth, idem, (req, res) => {
    const { board } = needBoard(req, req.params.id);
    const v = V.column(body(req));
    if (!v.ok) throw bad(v.errors);
    const cols = d.columns.filter((c) => c.boardId === board.id);
    if (cols.length >= 12) throw new HttpError(400, 'LIMIT', 'A board can have at most 12 lists.');
    const col = { id: store.nextId('columns'), boardId: board.id, name: v.value.name, position: cols.reduce((m, c) => Math.max(m, c.position), 0) + 1 };
    d.columns.push(col);
    commit(board, req, res, 'column.created', { column: { id: col.id, name: col.name, position: col.position } });
    res.status(201).json({ column: { id: col.id, name: col.name, position: col.position } });
  });

  app.patch('/api/columns/:id', auth, (req, res) => {
    const { column, board } = needColumn(req, req.params.id);
    const v = V.column(Object.assign({ name: column.name }, body(req)));
    if (!v.ok) throw bad(v.errors);
    column.name = v.value.name;
    commit(board, req, res, 'column.updated', { column: { id: column.id, name: column.name, position: column.position } });
    res.json({ column: { id: column.id, name: column.name, position: column.position } });
  });

  app.delete('/api/columns/:id', auth, (req, res) => {
    const { column, board } = needColumn(req, req.params.id);
    const ids = new Set(d.tasks.filter((t) => t.columnId === column.id).map((t) => t.id));
    d.comments = d.comments.filter((c) => !ids.has(c.taskId));
    d.tasks = d.tasks.filter((t) => t.columnId !== column.id);
    d.columns = d.columns.filter((c) => c !== column);
    commit(board, req, res, 'column.deleted', { id: column.id, taskIds: Array.from(ids) });
    res.json({ ok: true });
  });

  /* ---------- tasks ---------- */
  function checkAssignee(board, assigneeId) {
    if (assigneeId !== null && assigneeId !== undefined && !membership(board.id, assigneeId)) {
      throw bad({ assigneeId: 'Assignee must be a member of this board.' });
    }
  }

  app.post('/api/columns/:id/tasks', auth, idem, (req, res) => {
    const { column, board } = needColumn(req, req.params.id);
    const v = V.task(body(req), false);
    if (!v.ok) throw bad(v.errors);
    checkAssignee(board, v.value.assigneeId);
    const t = now();
    const list = inColumn(column.id);
    const task = {
      id: store.nextId('tasks'), boardId: board.id, columnId: column.id, title: v.value.title, description: v.value.description || '',
      priority: v.value.priority, due: v.value.due || null, assigneeId: v.value.assigneeId || null,
      position: list.length + 1, createdBy: req.user.id, createdAt: t, updatedAt: t,
      rev: 1, fieldRevs: { title: 1, description: 1, priority: 1, due: 1, assigneeId: 1 }, fieldBy: {}
    };
    d.tasks.push(task);
    commit(board, req, res, 'task.created', { task: taskOut(task) });
    res.status(201).json({ task: taskOut(task) });
  });

  app.get('/api/tasks/:id', auth, (req, res) => {
    const { task } = needTask(req, req.params.id);
    const comments = d.comments.filter((c) => c.taskId === task.id).sort((a, b) => a.id - b.id).map(commentOut);
    res.json({ task: taskOut(task), comments });
  });

  /* PATCH with conflict detection.
     The client sends only the fields it changed plus `baseRev` (the task revision it was looking at).
     Every content field remembers the revision at which it last changed (fieldRevs). A field conflicts
     only if someone else changed THAT field after baseRev. Edits to different fields merge cleanly. */
  const CONTENT = ['title', 'description', 'priority', 'due', 'assigneeId'];
  app.patch('/api/tasks/:id', auth, (req, res) => {
    const { task, board } = needTask(req, req.params.id);
    const b = body(req);
    const v = V.task(b, true);
    if (!v.ok) throw bad(v.errors);
    let baseRev;
    if (b.baseRev !== undefined && b.baseRev !== null) {
      if (!Number.isInteger(b.baseRev) || b.baseRev < 1) throw bad({ baseRev: 'baseRev must be a whole number, 1 or more.' });
      baseRev = b.baseRev;
    }
    checkAssignee(board, v.value.assigneeId);
    task.rev = task.rev || 1;
    task.fieldRevs = task.fieldRevs || {};
    const changes = {}, conflicts = [];
    CONTENT.forEach((f) => {
      if (!(f in v.value) || v.value[f] === task[f] || (f === 'description' && v.value[f] === (task[f] || ''))) return;
      changes[f] = v.value[f];
      if (baseRev !== undefined && (task.fieldRevs[f] || 1) > baseRev) {
        const who = d.users.find((u) => u.id === (task.fieldBy || {})[f]);
        conflicts.push({ field: f, yours: v.value[f], theirs: task[f], by: who ? { id: who.id, name: who.name } : null }); // who made the other change
      }
    });
    if (conflicts.length) {
      throw new HttpError(409, 'CONFLICT', 'Someone else changed this task while you were editing.', null, { conflicts, current: taskOut(task) });
    }
    const fields = Object.keys(changes);
    if (!fields.length) return res.json({ task: taskOut(task), unchanged: true }); // nothing to do: no version bump, no event
    task.rev += 1;
    task.fieldBy = task.fieldBy || {};
    fields.forEach((f) => { task[f] = changes[f]; task.fieldRevs[f] = task.rev; task.fieldBy[f] = req.user.id; });
    task.updatedAt = now();
    commit(board, req, res, 'task.updated', { task: taskOut(task), changed: fields });
    res.json({ task: taskOut(task) });
  });

  // Move to a list and position: { columnId, index } (index = 0-based place in the destination list)
  app.post('/api/tasks/:id/move', auth, (req, res) => {
    const { task, board } = needTask(req, req.params.id);
    const b = body(req);
    const destId = toId(b.columnId);
    const dest = destId && d.columns.find((c) => c.id === destId && c.boardId === board.id);
    if (!dest) throw bad({ columnId: 'Choose a list on this board.' });
    if (!Number.isInteger(b.index) || b.index < 0) throw bad({ index: 'Position must be a whole number, 0 or more.' });
    const fromId = task.columnId;
    const list = inColumn(dest.id).filter((x) => x.id !== task.id);
    list.splice(Math.min(b.index, list.length), 0, task);
    task.columnId = dest.id; task.updatedAt = now(); task.rev = (task.rev || 1) + 1;
    reindex(list);
    const affected = list.slice();
    if (fromId !== dest.id) { const rest = inColumn(fromId); reindex(rest); affected.push(...rest); }
    commit(board, req, res, 'task.moved', { task: taskOut(task), positions: affected.map((t) => ({ id: t.id, columnId: t.columnId, position: t.position })) });
    res.json({ task: taskOut(task) });
  });

  app.delete('/api/tasks/:id', auth, (req, res) => {
    const { task, board } = needTask(req, req.params.id);
    d.comments = d.comments.filter((c) => c.taskId !== task.id);
    d.tasks = d.tasks.filter((t) => t !== task);
    const rest = inColumn(task.columnId);
    reindex(rest);
    commit(board, req, res, 'task.deleted', { id: task.id, columnId: task.columnId, positions: rest.map((t) => ({ id: t.id, columnId: t.columnId, position: t.position })) });
    res.json({ ok: true });
  });

  /* ---------- comments ---------- */
  app.post('/api/tasks/:id/comments', auth, idem, (req, res) => {
    const { task, board } = needTask(req, req.params.id);
    const v = V.comment(body(req));
    if (!v.ok) throw bad(v.errors);
    const c = { id: store.nextId('comments'), taskId: task.id, authorId: req.user.id, body: v.value.body, createdAt: now() };
    d.comments.push(c);
    const count = d.comments.filter((x) => x.taskId === task.id).length;
    commit(board, req, res, 'comment.created', { comment: commentOut(c), taskId: task.id, commentCount: count });
    res.status(201).json({ comment: commentOut(c) });
  });

  app.delete('/api/comments/:id', auth, (req, res) => {
    const id = toId(req.params.id);
    const c = id && d.comments.find((x) => x.id === id);
    if (!c) throw new HttpError(404, 'NOT_FOUND', 'Comment not found.');
    const task = d.tasks.find((t) => t.id === c.taskId);
    const { board, me } = needBoard(req, task.boardId);
    if (c.authorId !== req.user.id && me.role !== 'owner') throw new HttpError(403, 'FORBIDDEN', 'You can only delete your own comments.');
    d.comments = d.comments.filter((x) => x !== c);
    commit(board, req, res, 'comment.deleted', { id: c.id, taskId: task.id, commentCount: d.comments.filter((x) => x.taskId === task.id).length });
    res.json({ ok: true });
  });

  /* ---------- real-time: Server-Sent Events + presence ---------- */
  // GET /api/boards/:id/events?since=VERSION   (the browser adds Last-Event-ID itself when it reconnects)
  app.get('/api/boards/:id/events', auth, (req, res) => {
    const { board } = needBoard(req, req.params.id);
    const raw = req.get('last-event-id') !== undefined ? req.get('last-event-id') : req.query.since;
    const lastId = /^\d{1,9}$/.test(String(raw)) ? Number(raw) : null;
    hub.subscribe({ boardId: board.id, user: { id: req.user.id, name: req.user.name }, req, res, lastId, version: board.version });
  });

  // Tell others which task window I have open (null = none). connId comes from the `hello` event.
  app.post('/api/boards/:id/presence', auth, (req, res) => {
    const { board } = needBoard(req, req.params.id);
    const b = body(req);
    let taskId = null;
    if (b.taskId !== null && b.taskId !== undefined) {
      taskId = toId(b.taskId);
      if (!taskId || !d.tasks.some((t) => t.id === taskId && t.boardId === board.id)) throw bad({ taskId: 'Task not found on this board.' });
    }
    if (!hub.setEditing(board.id, req.user.id, String(b.connId || ''), taskId)) throw new HttpError(404, 'NO_CONNECTION', 'Live connection not found. Reconnect and try again.');
    res.json({ ok: true });
  });

  /* ---------- static files + errors ---------- */
  app.use('/api', (req, res, next) => next(new HttpError(404, 'NOT_FOUND', 'No such API route.')));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html', extensions: ['html'] }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = new HttpError(400, 'BAD_JSON', 'Request body is not valid JSON.');
    if (err.type === 'entity.too.large') err = new HttpError(413, 'TOO_LARGE', 'Request body is too large.');
    if (!(err instanceof HttpError)) { console.error(err); err = new HttpError(500, 'SERVER_ERROR', 'Something went wrong on our side. Please try again.'); }
    res.status(err.status).json({ error: Object.assign({ code: err.code, message: err.message, fields: err.fields }, err.extra) });
  });

  return app;
}

module.exports = { createApp, HttpError };
