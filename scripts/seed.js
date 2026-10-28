'use strict';
// Optional demo data: 3 users and one board, created through the real API.
// Usage: npm run seed   (then log in with sara@example.com / Demo1234)
const fs = require('fs');
const path = require('path');
const { createApp } = require('../server/app');
const { Store } = require('../server/db');

const file = path.resolve(process.env.DATA_FILE || 'data/db.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const server = createApp({ store: new Store(file), authLimit: 1000 }).listen(0, async () => {
  const base = 'http://127.0.0.1:' + server.address().port;
  const jars = {};
  async function call(who, method, url, body) {
    const res = await fetch(base + url, {
      method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'taskflow', Cookie: jars[who] || '' },
      body: body ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jars[who] = sc.split(';')[0];
    const json = await res.json();
    if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status + ' ' + JSON.stringify(json));
    return json;
  }
  try {
    const users = [['sara', 'Sara Khan'], ['omar', 'Omar Ali'], ['hina', 'Hina Malik']];
    for (const [k, name] of users) {
      try { await call(k, 'POST', '/api/auth/signup', { name, email: k + '@example.com', password: 'Demo1234' }); }
      catch (e) { await call(k, 'POST', '/api/auth/login', { email: k + '@example.com', password: 'Demo1234' }); }
    }
    const created = await call('sara', 'POST', '/api/boards', { name: 'Website Launch', description: 'Everything we need to ship the new company website.' });
    const id = created.board.id;
    await call('sara', 'POST', '/api/boards/' + id + '/members', { email: 'omar@example.com' });
    await call('sara', 'POST', '/api/boards/' + id + '/members', { email: 'hina@example.com' });
    const full = await call('sara', 'GET', '/api/boards/' + id);
    const [todo, doing, done] = full.columns;
    const uid = (email) => full.members.find((m) => m.email === email).id;
    const mk = async (col, t) => (await call('sara', 'POST', '/api/columns/' + col.id + '/tasks', t)).task;
    await mk(todo, { title: 'Write homepage copy', priority: 'medium', due: '2026-11-05', assigneeId: uid('hina@example.com'), description: 'Short, friendly, and focused on what we offer.' });
    await mk(todo, { title: 'Collect customer logos', priority: 'low', assigneeId: uid('omar@example.com') });
    await mk(todo, { title: 'Set up analytics', priority: 'low' });
    const t4 = await mk(doing, { title: 'Design pricing page', priority: 'high', due: '2026-11-02', assigneeId: uid('sara@example.com'), description: 'Three plans, monthly/yearly toggle, FAQ below.' });
    await mk(doing, { title: 'Build contact form with validation', priority: 'high', assigneeId: uid('omar@example.com') });
    await mk(done, { title: 'Pick colour palette and fonts', priority: 'medium', assigneeId: uid('hina@example.com') });
    await mk(done, { title: 'Register the domain name', priority: 'low' });
    await call('omar', 'POST', '/api/tasks/' + t4.id + '/comments', { body: 'Should we show prices in USD only for now?' });
    await call('sara', 'POST', '/api/tasks/' + t4.id + '/comments', { body: 'Yes, USD only. We can add currencies later.' });
    console.log('Seeded. Log in as sara@example.com / omar@example.com / hina@example.com, password Demo1234');
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  server.close();
});
