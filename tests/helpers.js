'use strict';
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { Store } = require('../server/db');

async function boot(opts) {
  const store = (opts && opts.store) || new Store(null);
  const app = createApp(Object.assign({ store, bcryptCost: 4, secret: 'test-secret', authLimit: 1000, graceMs: 60, heartbeatMs: 10000 }, opts));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  function client() {
    let cookie = '';
    const call = async function (method, url, body, headers) {
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
    call.cookie = () => cookie;
    return call;
  }
  async function user(name) {
    const c = client();
    const r = await c('POST', '/api/auth/signup', { name: name + ' Tester', email: name + '@example.com', password: 'Passw0rdX' });
    assert.equal(r.status, 201);
    c.id = r.body.user.id;
    return c;
  }
  // Open a Server-Sent Events stream and collect what arrives.
  async function stream(c, url, headers) {
    const ctl = new AbortController();
    const res = await fetch(base + url, { headers: Object.assign({ Cookie: c.cookie() }, headers), signal: ctl.signal });
    const out = { status: res.status, events: [], closed: false, abort: () => ctl.abort() };
    if (res.status !== 200) { ctl.abort(); return out; }
    (async () => {
      const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i); buf = buf.slice(i + 2);
            const ev = { raw: block };
            block.split('\n').forEach((line) => {
              const m = /^(\w+): ?(.*)$/.exec(line);
              if (!m) return;
              if (m[1] === 'data') ev.data = JSON.parse(m[2]); else ev[m[1]] = m[2];
            });
            out.events.push(ev);
          }
        }
      } catch (e) { /* aborted */ }
      out.closed = true;
    })();
    out.waitFor = async (pred, ms) => {
      const end = Date.now() + (ms || 2000);
      for (;;) {
        const hit = out.events.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error('timed out waiting for event; got: ' + out.events.map((e) => e.event).join(', '));
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    out.of = (type) => out.events.filter((e) => e.event === type);
    return out;
  }
  const close = () => { app.hub.close(); server.close(); };
  return { store, app, hub: app.hub, server, base, client, user, stream, close };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { boot, sleep };
