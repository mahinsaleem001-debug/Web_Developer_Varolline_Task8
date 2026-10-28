'use strict';
/* Real-time hub: Server-Sent Events (SSE) with presence, replay and resync.

   Every change to a board has a version number (1, 2, 3, ...). That number is the SSE event id.
   The hub keeps the last N events of each board in memory so a client that reconnects can say
   "the last event I saw was 41" (the browser sends this automatically as Last-Event-ID) and get
   events 42, 43, ... replayed, in order, exactly once. If the gap is too old (or the server
   restarted) the hub sends a `resync` event and the client reloads the board instead.

   Events without an id (hello, presence, ping, resync, removed) are not part of the history. */
const crypto = require('crypto');

class Hub {
  constructor(opts) {
    const o = opts || {};
    this.bufferSize = o.bufferSize || 200;       // events kept per board for replay
    this.heartbeatMs = o.heartbeatMs || 15000;   // ping interval (keeps proxies from closing idle streams)
    this.graceMs = o.graceMs === undefined ? 3000 : o.graceMs; // keep a user "online" this long after the last tab closes
    this.boards = new Map();
    this.timer = setInterval(() => this._ping(), this.heartbeatMs);
    this.timer.unref();
  }

  _board(id) {
    let b = this.boards.get(id);
    if (!b) { b = { events: [], conns: new Map(), lingering: new Map() }; this.boards.set(id, b); }
    return b;
  }

  _write(conn, text) {
    try { conn.res.write(text); return true; } catch (e) { return false; }
  }
  _send(conn, name, payload, id) {
    return this._write(conn, (id !== undefined ? 'id: ' + id + '\n' : '') + 'event: ' + name + '\ndata: ' + JSON.stringify(payload) + '\n\n');
  }
  _ping() {
    this.boards.forEach((b) => b.conns.forEach((c) => this._send(c, 'ping', { t: Date.now() })));
  }

  /* Publish one versioned change to everyone on the board and remember it for replay. */
  publish(boardId, evt) {
    const b = this._board(boardId);
    b.events.push(evt);
    if (b.events.length > this.bufferSize) b.events.splice(0, b.events.length - this.bufferSize);
    const payload = { id: evt.id, type: evt.type, by: evt.by, origin: evt.origin || null, data: evt.data };
    b.conns.forEach((c) => this._send(c, evt.type, payload, evt.id));
  }

  /* Open a stream. lastId = the last event id the client has seen (null = it just loaded the board at `version`). */
  subscribe(o) {
    const { boardId, user, req, res, version } = o;
    const b = this._board(boardId);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    if (res.socket) { res.socket.setNoDelay(true); res.socket.setKeepAlive(true); }
    const conn = { id: crypto.randomBytes(8).toString('hex'), userId: user.id, user, res, editing: null };
    // a random reconnect delay (2-4 s) so hundreds of clients do not all come back at the same millisecond
    this._write(conn, 'retry: ' + (2000 + Math.floor(Math.random() * 2000)) + '\n\n');
    this._send(conn, 'hello', { connId: conn.id, version });

    const lastId = o.lastId === null || o.lastId === undefined ? version : o.lastId;
    if (lastId > version) {
      this._send(conn, 'resync', { reason: 'client is ahead of the server', version });
    } else if (lastId < version) {
      const first = b.events.length ? b.events[0].id : null;
      const last = b.events.length ? b.events[b.events.length - 1].id : null;
      if (first !== null && first <= lastId + 1 && last === version) {
        b.events.filter((e) => e.id > lastId).forEach((e) =>
          this._send(conn, e.type, { id: e.id, type: e.type, by: e.by, origin: e.origin || null, data: e.data }, e.id));
      } else {
        this._send(conn, 'resync', { reason: 'history is no longer available', version });
      }
    }

    const timer = b.lingering.get(user.id);
    if (timer) { clearTimeout(timer.t); b.lingering.delete(user.id); }
    b.conns.set(conn.id, conn);
    this._broadcastPresence(boardId); // everyone (including the new tab) gets the updated list

    req.on('close', () => this._drop(boardId, conn));
    return conn;
  }

  _drop(boardId, conn) {
    const b = this.boards.get(boardId);
    if (!b || !b.conns.delete(conn.id)) return;
    const stillHere = Array.from(b.conns.values()).some((c) => c.userId === conn.userId);
    if (stillHere) return this._broadcastPresence(boardId);        // only the editing marker may have changed
    if (this.graceMs <= 0) return this._broadcastPresence(boardId);
    const t = setTimeout(() => { b.lingering.delete(conn.userId); this._broadcastPresence(boardId); }, this.graceMs);
    t.unref();
    b.lingering.set(conn.userId, { t, user: conn.user });
  }

  /* Who is online: one entry per person (several tabs count once) with the tasks they have open. */
  presence(boardId) {
    const b = this.boards.get(boardId);
    if (!b) return [];
    const map = new Map();
    b.conns.forEach((c) => {
      const e = map.get(c.userId) || { id: c.userId, name: c.user.name, tabs: 0, editing: [] };
      e.tabs += 1;
      if (c.editing && !e.editing.includes(c.editing)) e.editing.push(c.editing);
      map.set(c.userId, e);
    });
    b.lingering.forEach((l, userId) => { if (!map.has(userId)) map.set(userId, { id: userId, name: l.user.name, tabs: 0, editing: [] }); });
    return Array.from(map.values()).sort((a, c) => a.name.localeCompare(c.name));
  }
  _broadcastPresence(boardId) {
    const b = this.boards.get(boardId);
    if (!b) return;
    const users = this.presence(boardId);
    b.conns.forEach((c) => this._send(c, 'presence', { users }));
  }

  /* A person opened / closed a task window. Returns false if the connection is not theirs. */
  setEditing(boardId, userId, connId, taskId) {
    const b = this.boards.get(boardId);
    const c = b && b.conns.get(connId);
    if (!c || c.userId !== userId) return false;
    c.editing = taskId;
    this._broadcastPresence(boardId);
    return true;
  }

  /* Remove one person (kicked or left): tell their tabs, then close the streams. */
  closeUser(boardId, userId, name, payload) {
    const b = this.boards.get(boardId);
    if (!b) return;
    Array.from(b.conns.values()).filter((c) => c.userId === userId).forEach((c) => {
      this._send(c, name, payload || {});
      b.conns.delete(c.id);
      try { c.res.end(); } catch (e) { /* already closed */ }
    });
    const l = b.lingering.get(userId);
    if (l) { clearTimeout(l.t); b.lingering.delete(userId); }
    this._broadcastPresence(boardId);
  }

  closeBoard(boardId, name, payload) {
    const b = this.boards.get(boardId);
    if (!b) return;
    b.conns.forEach((c) => { this._send(c, name, payload || {}); try { c.res.end(); } catch (e) { /* closed */ } });
    b.lingering.forEach((l) => clearTimeout(l.t));
    this.boards.delete(boardId);
  }

  connectionCount() { let n = 0; this.boards.forEach((b) => { n += b.conns.size; }); return n; }

  close() {
    clearInterval(this.timer);
    this.boards.forEach((b) => {
      b.conns.forEach((c) => { try { c.res.end(); } catch (e) { /* closed */ } });
      b.lingering.forEach((l) => clearTimeout(l.t));
    });
    this.boards.clear();
  }
}

module.exports = { Hub };
