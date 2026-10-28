'use strict';
// Tiny JSON-file database. The whole dataset lives in memory (fast reads) and every change
// is written to disk atomically (write a temp file, then rename), so a crash can never
// leave a half-written database. Pass file = null for a pure in-memory store (tests).
const fs = require('fs');
const path = require('path');

const TABLES = ['users', 'boards', 'members', 'columns', 'tasks', 'comments'];

function empty() {
  const d = { seq: {} };
  TABLES.forEach((t) => { d[t] = []; d.seq[t] = 0; });
  return d;
}

class Store {
  constructor(file) {
    this.file = file || null;
    this.data = empty();
    if (this.file && fs.existsSync(this.file)) {
      const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = empty();
      TABLES.forEach((t) => { base[t] = loaded[t] || []; base.seq[t] = (loaded.seq && loaded.seq[t]) || base[t].reduce((m, r) => Math.max(m, r.id || 0), 0); });
      this.data = base;
    }
  }
  nextId(table) { return ++this.data.seq[table]; }
  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
