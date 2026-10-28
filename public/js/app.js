/* Taskflow Live front end. One state object, hash routing (#/login, #/boards, #/board/ID).
   Changes are saved without reloads: drag-and-drop is optimistic (UI moves first, rolls back with a
   Retry toast if the server says no). Teammates' changes arrive over Server-Sent Events (live.js) and
   are applied by sync.js; online users, "who is editing", reconnecting and edit conflicts are handled here. */
(function () {
  'use strict';
  const { el, icon, toast, confirmDialog, avatar, todayISO, dueLabel, timeAgo } = window.UI;
  const V = window.Validate;

  const state = {
    user: null, boards: null, board: null, version: 0,
    online: [], connId: null, status: 'connecting', flash: new Set(), resyncing: false, queue: [], taskCtx: null, live: null,
    filter: { q: '', mine: false }, pending: 0, drag: null, openTaskId: null
  };
  const $ = (id) => document.getElementById(id);
  const view = $('view');
  const PRIORITY_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
  const newKey = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
  const TAB_ID = 'tab-' + newKey().replace(/-/g, '').slice(0, 14);   // identifies this browser tab in every request
  window.Api.clientId = TAB_ID;

  /* =============== helpers =============== */
  const msgOf = (e) => (e && e.message) || 'Something went wrong.';
  const sorted = (tasks) => tasks.slice().sort((a, b) => a.position - b.position || a.id - b.id);
  const colTasks = (colId) => sorted(state.board.tasks.filter((t) => t.columnId === colId));
  const memberById = (id) => state.board && state.board.members.find((m) => m.id === id);
  const isOwner = () => state.board && state.board.role === 'owner';
  const taskById = (id) => state.board && state.board.tasks.find((t) => t.id === id);

  async function tracked(fn) { // counts in-flight requests so polling never overwrites an unsaved change
    state.pending++;
    try { return await fn(); } finally { state.pending--; }
  }

  function setBusy(btn, busy, label) {
    if (!btn) return;
    if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Saving…'; btn.disabled = true; btn.classList.add('busy'); }
    else { if (btn.dataset.label) btn.textContent = btn.dataset.label; btn.disabled = false; btn.classList.remove('busy'); }
  }

  function showFieldErrors(form, fields, fallback) {
    form.querySelectorAll('.field-error').forEach((n) => n.remove());
    form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    let first = null;
    Object.keys(fields || {}).forEach((name) => {
      const input = form.elements[name];
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      const err = el('p', { class: 'field-error', text: fields[name], id: 'err-' + name + '-' + Math.random().toString(36).slice(2, 7) });
      input.setAttribute('aria-describedby', err.id);
      input.insertAdjacentElement('afterend', err);
      first = first || input;
    });
    let banner = form.querySelector('.form-error');
    if (banner) banner.remove();
    if (fallback) {
      banner = el('p', { class: 'form-error', role: 'alert', text: fallback });
      form.prepend(banner);
    }
    if (first) first.focus();
  }

  function field(label, input, hint) {
    const id = 'f-' + (input.name || Math.random().toString(36).slice(2, 7));
    input.id = id;
    return el('div', { class: 'field' }, [el('label', { for: id, text: label }), input, hint ? el('p', { class: 'hint', text: hint }) : null]);
  }

  /* =============== auth state, session expiry =============== */
  window.Api.onUnauthorized = () => {
    if (!state.user) return;
    state.user = null; state.board = null; state.boards = null;
    stopLive();
    toast('Your session has expired. Please log in again.', { type: 'error' });
    location.hash = '#/login';
    route();
  };

  /* =============== top bar =============== */
  function renderTopbar() {
    const bar = $('topbar');
    if (!state.user) { bar.hidden = true; bar.replaceChildren(); return; }
    bar.hidden = false;
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    bar.replaceChildren(
      el('a', { href: '#/boards', class: 'brand', 'aria-label': 'Taskflow home' }, [el('span', { class: 'logo' }, icon('layout', 20)), el('span', { class: 'brand-name', text: 'Taskflow' })]),
      el('div', { class: 'spacer' }),
      el('div', { class: 'who' }, [avatar(state.user, 30), el('span', { class: 'who-name hide-sm', text: state.user.name })]),
      el('button', { type: 'button', class: 'btn icon', id: 'theme', 'aria-label': dark ? 'Switch to light theme' : 'Switch to dark theme', onclick: toggleTheme }, icon(dark ? 'sun' : 'moon')),
      el('button', { type: 'button', class: 'btn', onclick: logout }, [icon('logout', 16), el('span', { class: 'hide-sm', text: 'Log out' })])
    );
  }
  function toggleTheme() {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('taskflow-theme', next); } catch (e) { /* ignore */ }
    renderTopbar();
  }
  async function logout() {
    try { await window.Api.post('/api/auth/logout'); } catch (e) { /* session cookie is cleared server-side; ignore network errors */ }
    state.user = null; state.board = null; state.boards = null;
    stopLive();
    location.hash = '#/login';
    route();
  }

  /* =============== router =============== */
  function parseRoute() {
    const h = location.hash.replace(/^#/, '') || '/';
    const parts = h.split('/').filter(Boolean);
    if (parts[0] === 'board' && /^\d+$/.test(parts[1] || '')) return { name: 'board', id: Number(parts[1]) };
    if (parts[0] === 'boards') return { name: 'boards' };
    if (parts[0] === 'signup') return { name: 'signup' };
    if (parts[0] === 'login') return { name: 'login' };
    return { name: state.user ? 'boards' : 'login' };
  }
  function route() {
    const r = parseRoute();
    renderTopbar();
    stopLive();
    if (!state.user && r.name !== 'login' && r.name !== 'signup') { location.hash = '#/login'; return; }
    if (state.user && (r.name === 'login' || r.name === 'signup')) { location.hash = '#/boards'; return; }
    if (r.name !== 'board') state.board = null;
    if (r.name === 'login' || r.name === 'signup') renderAuth(r.name);
    else if (r.name === 'boards') showBoards();
    else showBoard(r.id);
    document.title = (r.name === 'board' ? 'Board' : r.name === 'boards' ? 'Your boards' : r.name === 'signup' ? 'Sign up' : 'Log in') + ' · Taskflow';
  }
  window.addEventListener('hashchange', route);

  /* =============== auth screens =============== */
  function renderAuth(mode) {
    const signup = mode === 'signup';
    const form = el('form', { class: 'auth-form', novalidate: true, 'aria-labelledby': 'auth-title' });
    const name = el('input', { name: 'name', type: 'text', autocomplete: 'name', maxlength: 50 });
    const email = el('input', { name: 'email', type: 'email', autocomplete: 'email', maxlength: 120 });
    const pw = el('input', { name: 'password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', maxlength: 72 });
    const submit = el('button', { type: 'submit', class: 'btn primary wide', text: signup ? 'Create account' : 'Log in' });
    if (signup) form.append(field('Full name', name));
    form.append(
      field('Email', email),
      field('Password', pw, signup ? 'At least 8 characters, with a letter and a number.' : null),
      submit
    );
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const payload = { name: name.value, email: email.value, password: pw.value };
      const v = (signup ? V.signup : V.login)(payload);
      if (!v.ok) return showFieldErrors(form, v.errors);
      showFieldErrors(form, {});
      setBusy(submit, true, signup ? 'Creating account…' : 'Logging in…');
      try {
        const data = await window.Api.post(signup ? '/api/auth/signup' : '/api/auth/login', v.value, { noAuthRedirect: true });
        state.user = data.user;
        location.hash = '#/boards';
        route();
      } catch (e) {
        showFieldErrors(form, e.fields, e.fields ? null : msgOf(e));
        setBusy(submit, false);
      }
    });

    const mock = el('div', { class: 'mock', 'aria-hidden': 'true' }, [
      ['To do', ['Write launch email', 'Fix mobile menu'], ''], ['In progress', ['Design pricing page'], 'high'], ['Done', ['Pick colours', 'Buy domain'], 'low']
    ].map((c) => el('div', { class: 'mock-col' }, [el('b', { text: c[0] })].concat(c[1].map((t, i) => el('div', { class: 'mock-card' }, [el('span', { text: t }), el('i', { class: 'dot ' + (c[2] || (i ? 'low' : 'medium')) })]))))));

    view.replaceChildren(el('div', { class: 'auth' }, [
      el('section', { class: 'auth-hero' }, [
        el('div', { class: 'brand light' }, [el('span', { class: 'logo' }, icon('layout', 22)), el('span', { class: 'brand-name', text: 'Taskflow' })]),
        el('h1', { text: 'Plan work together, one card at a time.' }),
        el('p', { text: 'Boards, lists, tasks, comments and teammates, all in one place. Drag a card and it is saved instantly.' }),
        mock
      ]),
      el('section', { class: 'auth-card' }, [
        el('h2', { id: 'auth-title', text: signup ? 'Create your account' : 'Welcome back' }),
        el('p', { class: 'muted', text: signup ? 'Start your first board in under a minute.' : 'Log in to see your boards.' }),
        form,
        el('p', { class: 'switch' }, [signup ? 'Already have an account? ' : 'New to Taskflow? ', el('a', { href: signup ? '#/login' : '#/signup', text: signup ? 'Log in' : 'Create an account' })])
      ])
    ]));
    (signup ? name : email).focus();
  }

  /* =============== boards list =============== */
  async function showBoards() {
    view.replaceChildren(el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, el('h1', { text: 'Your boards' })),
      el('div', { class: 'board-grid' }, [1, 2, 3].map(() => el('div', { class: 'board-card skeleton' })))
    ]));
    try {
      state.boards = (await window.Api.get('/api/boards')).boards;
    } catch (e) {
      if (e.status === 401) return;
      return view.replaceChildren(errorState('Could not load your boards', msgOf(e), showBoards));
    }
    renderBoards();
  }

  function errorState(title, message, retry) {
    return el('div', { class: 'state card' }, [
      el('div', { class: 'state-icon danger' }, icon('alert', 28)),
      el('h2', { text: title }), el('p', { class: 'muted', text: message }),
      retry ? el('button', { type: 'button', class: 'btn primary', text: 'Try again', onclick: retry }) : null
    ]);
  }

  function renderBoards() {
    const grid = el('div', { class: 'board-grid' });
    state.boards.forEach((b) => {
      grid.append(el('a', { class: 'board-card', href: '#/board/' + b.id }, [
        el('div', { class: 'bc-top' }, [el('h2', { text: b.name }), el('span', { class: 'pill ' + (b.role === 'owner' ? 'owner' : ''), text: b.role === 'owner' ? 'Owner' : 'Member' })]),
        el('p', { class: 'bc-desc', text: b.description || 'No description' }),
        el('div', { class: 'bc-meta' }, [el('span', {}, [icon('users', 15), ' ' + b.memberCount + (b.memberCount === 1 ? ' member' : ' members')]), el('span', {}, [icon('check', 15), ' ' + b.taskCount + (b.taskCount === 1 ? ' task' : ' tasks')])])
      ]));
    });
    const newBtn = el('button', { type: 'button', class: 'board-card new', onclick: openBoardDialog }, [icon('plus', 22), el('span', { text: 'New board' })]);
    grid.append(newBtn);
    view.replaceChildren(el('div', { class: 'page' }, [
      el('div', { class: 'page-head' }, [el('div', {}, [el('h1', { text: 'Your boards' }), el('p', { class: 'muted', text: 'You only see boards you belong to.' })]),
        el('button', { type: 'button', class: 'btn primary', onclick: openBoardDialog }, [icon('plus', 16), ' New board'])]),
      state.boards.length ? null : el('div', { class: 'empty-note card' }, [el('h2', { text: 'No boards yet' }), el('p', { class: 'muted', text: 'Create your first board to start adding lists and tasks, or ask a teammate to invite you to theirs.' })]),
      grid
    ]));
  }

  let dlgCancel = null; // the Esc handler of the task dialog (removed when another dialog opens)
  function openDialog(content, opts) {
    const dlg = $('dlg');
    if (dlgCancel) { dlg.removeEventListener('cancel', dlgCancel); dlgCancel = null; }
    dlg.className = 'dlg' + (opts && opts.wide ? ' wide' : '');
    dlg.replaceChildren(content);
    if (opts && opts.onClose) dlg.addEventListener('close', opts.onClose, { once: true });
    if (!dlg.open) dlg.showModal();
    return dlg;
  }
  const closeDialog = () => { const d = $('dlg'); if (d.open) d.close(); };
  const dlgHead = (title, onClose) => el('div', { class: 'dlg-head' }, [el('h2', { text: title }), el('button', { type: 'button', class: 'btn icon ghost', 'aria-label': 'Close', onclick: onClose || closeDialog }, icon('x'))]);

  function openBoardDialog(existing) {
    const editing = existing && existing.id;
    const form = el('form', { novalidate: true });
    const name = el('input', { name: 'name', type: 'text', maxlength: 60, value: editing ? existing.name : '' });
    const desc = el('textarea', { name: 'description', rows: 3, maxlength: 200 });
    desc.value = editing ? existing.description || '' : '';
    const submit = el('button', { type: 'submit', class: 'btn primary', text: editing ? 'Save' : 'Create board' });
    form.append(field('Board name', name), field('Description (optional)', desc), el('div', { class: 'dlg-actions' }, [el('button', { type: 'button', class: 'btn', text: 'Cancel', onclick: closeDialog }), submit]));
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = V.board({ name: name.value, description: desc.value });
      if (!v.ok) return showFieldErrors(form, v.errors);
      showFieldErrors(form, {});
      setBusy(submit, true);
      try {
        if (editing) {
          const r = await tracked(() => window.Api.patch('/api/boards/' + existing.id, v.value));
          state.board.board.name = r.board.name; state.board.board.description = r.board.description;
          closeDialog(); renderBoardView(); toast('Board updated.', { type: 'success' });
        } else {
          const r = await window.Api.post('/api/boards', v.value);
          closeDialog(); location.hash = '#/board/' + r.board.id;
        }
      } catch (e) { showFieldErrors(form, e.fields, e.fields ? null : msgOf(e)); setBusy(submit, false); }
    });
    openDialog(el('div', {}, [dlgHead(editing ? 'Edit board' : 'New board'), form]));
    name.focus();
  }

  /* =============== board =============== */
  async function loadBoard(id, silent) {
    const data = await window.Api.get('/api/boards/' + id);
    state.board = data;
    state.version = data.board.version;
    if (silent) {
      renderBoardView();
      if (state.openTaskId) refreshOpenTask();
    }
    return data;
  }

  /* ---------- live updates ---------- */
  function stopLive() {
    if (state.live) state.live.close();
    state.live = null; state.online = []; state.connId = null; state.queue = []; state.resyncing = false;
  }
  function startLive(id) {
    stopLive();
    let wasLive = false;
    state.status = 'connecting';
    state.live = window.Live.connect({
      boardId: id,
      getVersion: () => state.version,
      onEvent: onLiveEvent,
      onHello: (connId) => { state.connId = connId; if (state.openTaskId) postEditing(state.openTaskId); },
      onPresence: (users) => {
        const before = JSON.stringify(state.online.map((u) => [u.id, u.editing]));
        state.online = users;
        renderPresence();
        if (JSON.stringify(users.map((u) => [u.id, u.editing])) !== before) { if (!state.drag) renderColumns(); if (state.taskCtx) state.taskCtx.presence(); }
      },
      onStatus: (st) => {
        const prev = state.status;
        state.status = st; renderStatus();
        if (st === 'live' && wasLive && prev !== 'live') toast('Reconnected. You are up to date.', { type: 'success' });
        if (st === 'live') wasLive = true;
      },
      onResync: (why) => resync(why),
      onRemoved: () => { toast('You no longer have access to that board.', { type: 'error' }); closeDialog(); location.hash = '#/boards'; },
      onBoardDeleted: () => { toast('This board was deleted by its owner.', { type: 'error' }); closeDialog(); location.hash = '#/boards'; }
    });
  }

  function postEditing(taskId) {
    if (!state.board || !state.connId) return;
    window.Api.post('/api/boards/' + state.board.board.id + '/presence', { connId: state.connId, taskId }).catch(() => { /* presence is best effort */ });
  }

  // Missed events (gap, or the server no longer has our history): reload everything, then replay what arrived meanwhile.
  async function resync() {
    if (state.resyncing || !state.board) return;
    state.resyncing = true; state.queue = [];
    try {
      await loadBoard(state.board.board.id, true);
    } catch (e) {
      state.resyncing = false;
      if (e.status === 404) return;
      toast('Could not refresh the board. ' + msgOf(e), { type: 'error', action: { label: 'Retry', onClick: resync } });
      return;
    }
    state.resyncing = false;
    const queued = state.queue; state.queue = [];
    queued.sort((x, y) => x.id - y.id).forEach(onLiveEvent);   // older ones are dropped as duplicates
  }

  function onLiveEvent(evt) {
    if (!state.board) return;
    if (state.resyncing) { state.queue.push(evt); return; }
    const own = evt.origin === TAB_ID;
    const st = { data: state.board, version: state.version };
    const r = window.Sync.apply(st, evt, { skipApply: own && state.pending > 0 });
    state.version = st.version;
    if (r.status === 'gap') return resync();
    if (r.status !== 'applied') return;
    const remote = !own;
    const by = (memberById(evt.by) || {}).name || 'Someone';
    let cols = false, head = false;
    r.effects.forEach((f) => {
      if (f.kind === 'task') {
        cols = true;
        if (remote) {
          state.flash.add(f.id);
          const tk = taskById(f.id), ch = (f.changed || []).filter((x) => ['title', 'description', 'priority', 'due', 'assigneeId'].includes(x));
          if (tk && ch.length) toast(by + ' changed the ' + ch.map((x) => x === 'assigneeId' ? 'assignee' : x === 'due' ? 'due date' : x).join(', ') + ' of "' + tk.title + '"', { type: 'info' });
        }
        if (state.taskCtx && state.taskCtx.id === f.id) { const t = taskById(f.id); if (t) state.taskCtx.remote(t, f.changed, by); }
      } else if (f.kind === 'task-deleted') {
        cols = true;
        if (state.taskCtx && state.taskCtx.id === f.id) state.taskCtx.removed(by);
      } else if (f.kind === 'comment') {
        cols = true;
        if (state.taskCtx && state.taskCtx.id === f.taskId) { if (f.comment) state.taskCtx.comment(f.comment); else state.taskCtx.uncomment(f.deletedId); }
        if (remote && f.comment) state.flash.add(f.taskId);
      } else if (f.kind === 'columns' || f.kind === 'tasks') cols = true;
      else if (f.kind === 'members') {
        head = true; cols = true;
        if (f.removedUserId === state.user.id) { toast('You were removed from this board.', { type: 'error' }); closeDialog(); location.hash = '#/boards'; }
      } else if (f.kind === 'board') head = true;
    });
    if (head) { renderHead(); const md = $('dlg'); if (md.open && md.querySelector('.member-list')) openMembersDialog(); }
    if (cols && !state.drag) renderColumns();
    state.flash.clear();
    renderPresence();
  }

  function renderStatus() {
    const n = $('conn');
    if (!n) return;
    const label = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…', offline: 'Offline' }[state.status] || state.status;
    n.className = 'conn ' + state.status;
    n.replaceChildren(el('i', { class: 'conn-dot' }), label);
    n.title = state.status === 'live' ? 'Changes from teammates appear instantly.' : state.status === 'offline' ? 'No internet. Changes made now cannot be saved.' : 'Trying to reconnect. You will be caught up automatically.';
  }

  function renderPresence() {
    const box = $('presence');
    if (!box) return;
    const users = state.online;
    box.replaceChildren(
      el('span', { class: 'stack online-stack' }, users.slice(0, 5).map((u) => { const a = avatar(u, 28); a.title = u.name + (u.id === state.user.id ? ' (you)' : '') + (u.editing.length ? ' is editing a task' : ''); a.classList.add('is-online'); return a; })),
      el('span', { class: 'hide-sm', text: users.length + ' online' })
    );
    box.setAttribute('aria-label', users.length + ' online: ' + users.map((u) => u.name).join(', '));
  }

  async function showBoard(id) {
    view.replaceChildren(el('div', { class: 'page wide' }, [
      el('div', { class: 'page-head' }, el('div', { class: 'sk sk-title' })),
      el('div', { class: 'cols' }, [1, 2, 3].map(() => el('div', { class: 'col skeleton' })))
    ]));
    try { await loadBoard(id, false); }
    catch (e) {
      if (e.status === 401) return;
      return view.replaceChildren(errorState(e.status === 404 ? 'Board not found' : 'Could not load this board',
        e.status === 404 ? 'It may have been deleted, or you are not a member of it.' : msgOf(e), e.status === 404 ? null : () => showBoard(id)),
        el('p', { class: 'center' }, el('a', { href: '#/boards', text: 'Back to your boards' })));
    }
    document.title = state.board.board.name + ' · Taskflow';
    renderBoardView();
    startLive(id);
  }

  function matchesFilter(t) {
    const f = state.filter;
    if (f.mine && t.assigneeId !== state.user.id) return false;
    if (f.q) {
      const q = f.q.toLowerCase();
      const a = memberById(t.assigneeId);
      if (!(t.title.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q) || (a && a.name.toLowerCase().includes(q)))) return false;
    }
    return true;
  }

  function headEl() {
    const b = state.board;
    return el('div', { class: 'page-head board-head', id: 'bhead' }, [
      el('div', { class: 'bh-left' }, [
        el('a', { href: '#/boards', class: 'back' }, [icon('back', 16), ' Boards']),
        el('h1', { text: b.board.name }),
        b.board.description ? el('p', { class: 'muted', text: b.board.description }) : null
      ]),
      el('div', { class: 'bh-right' }, [
        el('button', { type: 'button', class: 'members-btn', 'aria-label': 'Members (' + b.members.length + ')', onclick: openMembersDialog }, [
          el('span', { class: 'stack' }, b.members.slice(0, 4).map((m) => avatar(m, 28))),
          el('span', { class: 'hide-sm', text: b.members.length + (b.members.length === 1 ? ' member' : ' members') })
        ]),
        isOwner() ? el('button', { type: 'button', class: 'btn icon', 'aria-label': 'Edit board', title: 'Edit board', onclick: () => openBoardDialog(b.board) }, icon('edit')) : null,
        isOwner() ? el('button', { type: 'button', class: 'btn icon danger-ghost', 'aria-label': 'Delete board', title: 'Delete board', onclick: deleteBoard }, icon('trash')) : null
      ])
    ]);
  }
  function renderHead() { const h = $('bhead'); if (h) h.replaceWith(headEl()); }

  function renderBoardView() {
    const b = state.board;
    const keepScroll = view.querySelector('.cols') ? view.querySelector('.cols').scrollLeft : 0;
    const head = headEl();

    const search = el('input', { type: 'search', class: 'search', placeholder: 'Search tasks…', 'aria-label': 'Search tasks', value: state.filter.q });
    search.addEventListener('input', () => { state.filter.q = search.value.trim(); renderColumns(); });
    const mine = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(state.filter.mine), text: 'My tasks' });
    mine.addEventListener('click', () => { state.filter.mine = !state.filter.mine; mine.setAttribute('aria-pressed', String(state.filter.mine)); renderColumns(); });
    const bar = el('div', { class: 'filter-bar' }, [el('div', { class: 'search-wrap' }, [icon('search', 16), search]), mine, el('span', { class: 'grow' }), el('span', { id: 'conn', class: 'conn', role: 'status' }), el('div', { id: 'presence', class: 'presence', role: 'group' })]);

    view.replaceChildren(el('div', { class: 'page wide' }, [head, bar, el('div', { class: 'cols', id: 'cols' })]));
    renderColumns();
    renderStatus(); renderPresence();
    view.querySelector('.cols').scrollLeft = keepScroll;
  }

  async function deleteBoard() {
    const ok = await confirmDialog({ title: 'Delete this board?', message: 'All lists, tasks and comments on "' + state.board.board.name + '" will be deleted for everyone. This cannot be undone.', confirmText: 'Delete board', danger: true });
    if (!ok) return;
    try { await tracked(() => window.Api.del('/api/boards/' + state.board.board.id)); toast('Board deleted.', { type: 'success' }); location.hash = '#/boards'; }
    catch (e) { toast(msgOf(e), { type: 'error' }); }
  }

  /* ---------- columns and cards ---------- */
  function renderColumns() {
    const box = $('cols');
    if (!box) return;
    const keep = box.scrollLeft;
    box.replaceChildren();
    state.board.columns.forEach((c) => box.append(columnEl(c)));
    box.append(addColumnEl());
    box.scrollLeft = keep;
  }

  function columnEl(c) {
    const all = colTasks(c.id);
    const shown = all.filter(matchesFilter);
    const filtering = state.filter.q || state.filter.mine;
    const body = el('div', { class: 'col-body', dataset: { col: c.id } });
    shown.forEach((t) => body.append(cardEl(t)));
    if (!shown.length) body.append(el('p', { class: 'col-empty', text: filtering && all.length ? 'No matching tasks' : 'No tasks yet' }));
    wireDropZone(body, c.id);

    const title = el('button', { type: 'button', class: 'col-title', title: 'Click to rename', onclick: () => renameColumn(c, title) }, [el('span', { text: c.name })]);
    const head = el('div', { class: 'col-head' }, [
      title,
      el('span', { class: 'count', 'aria-label': all.length + ' tasks', text: filtering ? shown.length + '/' + all.length : String(all.length) }),
      el('button', { type: 'button', class: 'btn icon ghost sm', 'aria-label': 'Delete list ' + c.name, title: 'Delete list', onclick: () => deleteColumn(c, all.length) }, icon('trash', 15))
    ]);
    const col = el('section', { class: 'col', 'aria-label': c.name + ', ' + all.length + ' tasks' }, [head, body, composerEl(c)]);
    return col;
  }

  function cardEl(t) {
    const a = memberById(t.assigneeId);
    const overdue = t.due && t.due < todayISO();
    const meta = el('div', { class: 'card-meta' }, [
      el('span', { class: 'prio ' + t.priority, title: PRIORITY_LABEL[t.priority] + ' priority' }, [el('i', { class: 'dot ' + t.priority }), PRIORITY_LABEL[t.priority]]),
      t.due ? el('span', { class: 'chip-sm' + (overdue ? ' overdue' : ''), title: overdue ? 'Overdue' : 'Due date' }, [icon('calendar', 13), ' ' + dueLabel(t.due)]) : null,
      t.commentCount ? el('span', { class: 'chip-sm', title: t.commentCount + ' comments' }, [icon('chat', 13), ' ' + t.commentCount]) : null,
      el('span', { class: 'grow' }),
      a ? avatar(a, 24) : null
    ]);
    const editors = state.online.filter((u) => u.id !== state.user.id && u.editing.includes(t.id));
    if (editors.length) meta.insertBefore(el('span', { class: 'editing', title: editors.map((u) => u.name).join(', ') + ' is editing this task' }, [icon('edit', 12), ' ' + editors[0].name.split(' ')[0] + (editors.length > 1 ? ' +' + (editors.length - 1) : '')]), meta.querySelector('.grow'));
    const card = el('article', {
      class: 'card-task' + (state.flash.has(t.id) ? ' flash' : ''), draggable: true, tabindex: 0, role: 'button', dataset: { id: t.id },
      'aria-label': t.title + '. ' + PRIORITY_LABEL[t.priority] + ' priority.' + (a ? ' Assigned to ' + a.name + '.' : '') + ' Press Enter to open, Alt plus arrow keys to move.'
    }, [el('p', { class: 'card-title', text: t.title }), meta]);

    card.addEventListener('click', () => openTask(t.id));
    card.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); return openTask(t.id); }
      if (!ev.altKey || !/^Arrow/.test(ev.key)) return;
      ev.preventDefault();
      keyboardMove(t, ev.key);
    });
    card.addEventListener('dragstart', (ev) => {
      state.drag = { id: t.id, target: null };
      ev.dataTransfer.effectAllowed = 'move';
      ev.dataTransfer.setData('text/plain', String(t.id));
      setTimeout(() => card.classList.add('dragging'), 0);
    });
    card.addEventListener('dragend', endDrag);
    return card;
  }

  /* ---------- drag and drop ---------- */
  let dropLine = null;
  function endDrag() {
    state.drag = null;
    if (dropLine) { dropLine.remove(); dropLine = null; }
    document.querySelectorAll('.dragging, .drop-active').forEach((n) => n.classList.remove('dragging', 'drop-active'));
  }

  function wireDropZone(body, colId) {
    body.addEventListener('dragover', (ev) => {
      if (!state.drag) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      body.classList.add('drop-active');
      // scroll the board sideways when the pointer is near its edges
      const cols = $('cols');
      const r = cols.getBoundingClientRect();
      if (ev.clientX < r.left + 70) cols.scrollLeft -= 18; else if (ev.clientX > r.right - 70) cols.scrollLeft += 18;

      const cards = Array.from(body.querySelectorAll('.card-task:not(.dragging)'));
      const before = cards.find((c) => ev.clientY < c.getBoundingClientRect().top + c.offsetHeight / 2) || null;
      const full = colTasks(colId).filter((t) => t.id !== state.drag.id);
      const index = before ? Math.max(0, full.findIndex((t) => t.id === Number(before.dataset.id))) : full.length;
      state.drag.target = { colId, index };
      if (!dropLine) dropLine = el('div', { class: 'drop-line' });
      const empty = body.querySelector('.col-empty');
      if (empty) empty.hidden = true;
      if (before) body.insertBefore(dropLine, before); else body.append(dropLine);
    });
    body.addEventListener('dragleave', (ev) => {
      if (!body.contains(ev.relatedTarget)) { body.classList.remove('drop-active'); if (dropLine) dropLine.remove(); const e = body.querySelector('.col-empty'); if (e) e.hidden = false; }
    });
    body.addEventListener('drop', (ev) => {
      ev.preventDefault();
      const d = state.drag;
      const target = d && d.target;
      endDrag();
      if (d && target) moveTask(d.id, target.colId, target.index);
    });
  }

  // Optimistic move: update the screen first, then tell the server. Roll back if it fails.
  function applyMoveLocally(taskId, colId, index) {
    const tasks = state.board.tasks;
    const t = tasks.find((x) => x.id === taskId);
    const from = t.columnId;
    const list = sorted(tasks.filter((x) => x.columnId === colId && x.id !== taskId));
    list.splice(Math.min(index, list.length), 0, t);
    t.columnId = colId;
    list.forEach((x, i) => { x.position = i + 1; });
    if (from !== colId) sorted(tasks.filter((x) => x.columnId === from)).forEach((x, i) => { x.position = i + 1; });
  }

  async function moveTask(taskId, colId, index, focusAfter) {
    const t = taskById(taskId);
    if (!t) return;
    const cur = colTasks(t.columnId);
    if (t.columnId === colId && cur.findIndex((x) => x.id === taskId) === Math.min(index, cur.length - 1)) return; // dropped where it was
    const snapshot = JSON.parse(JSON.stringify(state.board.tasks));
    applyMoveLocally(taskId, colId, index);
    renderColumns();
    if (focusAfter) { const n = view.querySelector('.card-task[data-id="' + taskId + '"]'); if (n) n.focus(); }
    try {
      await tracked(() => window.Api.post('/api/tasks/' + taskId + '/move', { columnId: colId, index }));
    } catch (e) {
      if (state.board) { state.board.tasks = snapshot; renderColumns(); }
      if (e.status === 401) return;
      toast('Could not move "' + t.title + '". It was put back. ' + msgOf(e), { type: 'error', action: e.status === 404 ? null : { label: 'Retry', onClick: () => moveTask(taskId, colId, index) } });
      if (e.status === 404 && state.board) loadBoard(state.board.board.id, true).catch(() => {});
    }
  }

  function keyboardMove(t, key) {
    const cols = state.board.columns;
    const ci = cols.findIndex((c) => c.id === t.columnId);
    const list = colTasks(t.columnId);
    const pos = list.findIndex((x) => x.id === t.id);
    if (key === 'ArrowUp' && pos > 0) moveTask(t.id, t.columnId, pos - 1, true);
    else if (key === 'ArrowDown' && pos < list.length - 1) moveTask(t.id, t.columnId, pos + 1, true);
    else if (key === 'ArrowLeft' && ci > 0) moveTask(t.id, cols[ci - 1].id, Math.min(pos, colTasks(cols[ci - 1].id).length), true);
    else if (key === 'ArrowRight' && ci < cols.length - 1) moveTask(t.id, cols[ci + 1].id, Math.min(pos, colTasks(cols[ci + 1].id).length), true);
  }

  /* ---------- list actions ---------- */
  function composerEl(c) {
    const wrap = el('div', { class: 'composer' });
    const openBtn = el('button', { type: 'button', class: 'add-task', onclick: open }, [icon('plus', 16), ' Add task']);
    wrap.append(openBtn);
    function open() {
      const input = el('textarea', { rows: 2, maxlength: 120, placeholder: 'What needs doing?', 'aria-label': 'New task title' });
      const add = el('button', { type: 'submit', class: 'btn primary sm', text: 'Add task' });
      const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
      const form = el('form', { class: 'composer-form', novalidate: true }, [input, err, el('div', { class: 'row' }, [add, el('button', { type: 'button', class: 'btn sm', text: 'Cancel', onclick: close })])]);
      let key = null; // same key on a retry => the server creates the task only once
      input.addEventListener('input', () => { key = null; });
      function close() { wrap.replaceChildren(openBtn); }
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); } else if (ev.key === 'Escape') close(); });
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = V.task({ title: input.value }, false);
        if (!v.ok) { err.textContent = v.errors.title; err.hidden = false; input.focus(); return; }
        err.hidden = true; setBusy(add, true, 'Adding…'); input.disabled = true;
        try {
          key = key || newKey();
          const r = await tracked(() => window.Api.post('/api/columns/' + c.id + '/tasks', { title: v.value.title }, { idem: key }));
          key = null;
          if (!taskById(r.task.id)) state.board.tasks.push(r.task);
          renderColumns();
          const again = view.querySelector('.col-body[data-col="' + c.id + '"]');
          if (again) again.closest('.col').querySelector('.add-task').click();
        } catch (e) {
          if (e.status === 401) return;
          input.disabled = false; setBusy(add, false);
          err.textContent = (e.fields && e.fields.title) || msgOf(e); err.hidden = false; input.focus();
        }
      });
      wrap.replaceChildren(form);
      input.focus();
    }
    return wrap;
  }

  function renameColumn(c, titleBtn) {
    const input = el('input', { class: 'col-rename', type: 'text', maxlength: 40, value: c.name, 'aria-label': 'List name' });
    let done = false;
    async function commit(save) {
      if (done) return; done = true;
      const name = input.value.trim();
      if (!save || name === c.name) return renderColumns();
      const v = V.column({ name });
      if (!v.ok) { toast(v.errors.name, { type: 'error' }); return renderColumns(); }
      const old = c.name; c.name = v.value.name; renderColumns();   // optimistic
      try { await tracked(() => window.Api.patch('/api/columns/' + c.id, { name: v.value.name })); }
      catch (e) { c.name = old; renderColumns(); if (e.status !== 401) toast('Could not rename the list. ' + msgOf(e), { type: 'error' }); }
    }
    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commit(true); else if (ev.key === 'Escape') commit(false); });
    input.addEventListener('blur', () => commit(true));
    titleBtn.replaceWith(input);
    input.focus(); input.select();
  }

  async function deleteColumn(c, n) {
    const ok = await confirmDialog({ title: 'Delete list "' + c.name + '"?', message: n ? n + (n === 1 ? ' task' : ' tasks') + ' in this list will be deleted too. This cannot be undone.' : 'This list is empty.', confirmText: 'Delete list', danger: true });
    if (!ok) return;
    try {
      await tracked(() => window.Api.del('/api/columns/' + c.id));
      state.board.columns = state.board.columns.filter((x) => x.id !== c.id);
      state.board.tasks = state.board.tasks.filter((t) => t.columnId !== c.id);
      renderColumns(); toast('List deleted.', { type: 'success' });
    } catch (e) { if (e.status !== 401) toast('Could not delete the list. ' + msgOf(e), { type: 'error' }); }
  }

  function addColumnEl() {
    const wrap = el('div', { class: 'col add-col' });
    const btn = el('button', { type: 'button', class: 'add-list', onclick: open }, [icon('plus', 16), ' Add another list']);
    wrap.append(btn);
    function open() {
      const input = el('input', { type: 'text', maxlength: 40, placeholder: 'List name', 'aria-label': 'New list name' });
      const add = el('button', { type: 'submit', class: 'btn primary sm', text: 'Add list' });
      const err = el('p', { class: 'field-error', hidden: true, role: 'alert' });
      let key = null;
      input.addEventListener('input', () => { key = null; });
      const form = el('form', { novalidate: true }, [input, err, el('div', { class: 'row' }, [add, el('button', { type: 'button', class: 'btn sm', text: 'Cancel', onclick: () => wrap.replaceChildren(btn) })])]);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = V.column({ name: input.value });
        if (!v.ok) { err.textContent = v.errors.name; err.hidden = false; return input.focus(); }
        setBusy(add, true, 'Adding…');
        try {
          key = key || newKey();
          const r = await tracked(() => window.Api.post('/api/boards/' + state.board.board.id + '/columns', { name: v.value.name }, { idem: key }));
          key = null;
          if (!state.board.columns.some((x) => x.id === r.column.id)) state.board.columns.push(r.column);
          renderColumns();
        } catch (e) { if (e.status === 401) return; setBusy(add, false); err.textContent = msgOf(e); err.hidden = false; }
      });
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') wrap.replaceChildren(btn); });
      wrap.replaceChildren(form); input.focus();
    }
    return wrap;
  }

  /* =============== members dialog =============== */
  function openMembersDialog() {
    const b = state.board;
    const list = el('ul', { class: 'member-list' });
    b.members.forEach((m) => {
      const mine = m.id === state.user.id;
      const canRemove = m.role !== 'owner' && (isOwner() || mine);
      list.append(el('li', {}, [
        avatar(m, 34),
        el('div', { class: 'ml-info' }, [el('strong', { text: m.name + (mine ? ' (you)' : '') }), el('span', { class: 'muted', text: m.email })]),
        state.online.some((u) => u.id === m.id) ? el('span', { class: 'pill online', text: 'Online' }) : null,
        el('span', { class: 'pill ' + (m.role === 'owner' ? 'owner' : ''), text: m.role === 'owner' ? 'Owner' : 'Member' }),
        canRemove ? el('button', { type: 'button', class: 'btn sm danger-ghost', text: mine ? 'Leave' : 'Remove', 'aria-label': (mine ? 'Leave board' : 'Remove ' + m.name), onclick: () => removeMember(m) }) : null
      ]));
    });
    const parts = [dlgHead('Board members'), list];
    if (isOwner()) {
      const email = el('input', { name: 'email', type: 'email', placeholder: 'teammate@example.com', maxlength: 120 });
      const add = el('button', { type: 'submit', class: 'btn primary', text: 'Invite' });
      const form = el('form', { class: 'invite', novalidate: true }, [field('Invite by email', email, 'They need a Taskflow account first.'), add]);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const v = V.member({ email: email.value });
        if (!v.ok) return showFieldErrors(form, v.errors);
        showFieldErrors(form, {});
        setBusy(add, true, 'Inviting…');
        try {
          const r = await tracked(() => window.Api.post('/api/boards/' + b.board.id + '/members', v.value));
          state.board.members = r.members;
          toast('Invitation done. They can see this board now.', { type: 'success' });
          openMembersDialog(); renderBoardView();
        } catch (e) { setBusy(add, false); if (e.status !== 401) showFieldErrors(form, e.fields, e.fields ? null : msgOf(e)); }
      });
      parts.push(form);
    }
    openDialog(el('div', {}, parts));
  }

  async function removeMember(m) {
    const mine = m.id === state.user.id;
    const ok = await confirmDialog({ title: mine ? 'Leave this board?' : 'Remove ' + m.name + '?', message: mine ? 'You will lose access to this board. Tasks assigned to you become unassigned.' : m.name + ' will lose access, and their tasks become unassigned.', confirmText: mine ? 'Leave board' : 'Remove', danger: true });
    if (!ok) return;
    try {
      await tracked(() => window.Api.del('/api/boards/' + state.board.board.id + '/members/' + m.id));
      if (mine) { closeDialog(); toast('You left the board.', { type: 'success' }); location.hash = '#/boards'; return; }
      state.board.members = state.board.members.filter((x) => x.id !== m.id);
      state.board.tasks.forEach((t) => { if (t.assigneeId === m.id) t.assigneeId = null; });
      renderBoardView(); openMembersDialog(); toast(m.name + ' was removed.', { type: 'success' });
    } catch (e) { if (e.status !== 401) toast(msgOf(e), { type: 'error' }); }
  }

  /* =============== task dialog =============== */
  const FIELDS = ['title', 'description', 'priority', 'due', 'assigneeId'];
  const FIELD_LABEL = { title: 'Title', description: 'Description', priority: 'Priority', due: 'Due date', assigneeId: 'Assignee' };
  const normTask = (t) => ({ title: t.title, description: t.description || '', priority: t.priority, due: t.due || '', assigneeId: t.assigneeId === null || t.assigneeId === undefined ? '' : String(t.assigneeId) });

  async function openTask(id) {
    const t = taskById(id);
    if (!t) return;
    state.openTaskId = id;
    const b = state.board;
    const form = el('form', { class: 'task-form', novalidate: true });
    const title = el('input', { name: 'title', type: 'text', maxlength: 120, value: t.title });
    const desc = el('textarea', { name: 'description', rows: 4, maxlength: 2000, placeholder: 'Add more detail…' });
    desc.value = t.description || '';
    const column = el('select', { name: 'columnId' }, b.columns.map((c) => el('option', { value: c.id, text: c.name, selected: c.id === t.columnId })));
    const prio = el('select', { name: 'priority' }, ['low', 'medium', 'high'].map((p) => el('option', { value: p, text: PRIORITY_LABEL[p], selected: p === t.priority })));
    const assignee = el('select', { name: 'assigneeId' }, [el('option', { value: '', text: 'Unassigned' })].concat(b.members.map((m) => el('option', { value: m.id, text: m.name, selected: m.id === t.assigneeId }))));
    const due = el('input', { name: 'due', type: 'date', value: t.due || '' });
    const save = el('button', { type: 'submit', class: 'btn primary', text: 'Save changes' });
    const del = el('button', { type: 'button', class: 'btn danger-ghost', onclick: () => deleteTask(t) }, [icon('trash', 15), ' Delete']);
    const hint = el('p', { class: 'hint save-hint', hidden: true, text: 'Choose a version for each highlighted field to save.' });
    const presenceNote = el('p', { class: 'presence-note', hidden: true, role: 'status' });

    form.append(
      field('Title', title), field('Description', desc),
      el('div', { class: 'grid2' }, [field('List', column), field('Priority', prio), field('Assignee', assignee), field('Due date', due)]),
      hint,
      el('div', { class: 'dlg-actions split' }, [del, el('div', { class: 'row' }, [el('button', { type: 'button', class: 'btn', text: 'Close', onclick: attemptClose }), save])])
    );

    const clist = el('ul', { class: 'comments', 'aria-live': 'polite' });
    const cbox = el('textarea', { name: 'body', rows: 2, maxlength: 1000, placeholder: 'Write a comment…', 'aria-label': 'New comment' });
    const cbtn = el('button', { type: 'submit', class: 'btn primary sm', text: 'Comment' });
    const cform = el('form', { class: 'comment-form', novalidate: true }, [cbox, el('div', { class: 'row end' }, cbtn)]);
    cbox.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); cform.requestSubmit(); } });
    let ckey = null;
    cbox.addEventListener('input', () => { ckey = null; });

    const wrap = el('div', { class: 'task-dlg' }, [
      dlgHead('Task details', attemptClose), presenceNote, form,
      el('section', { class: 'comments-sec', 'aria-labelledby': 'cm-h' }, [el('h3', { id: 'cm-h', text: 'Comments' }), clist, cform])
    ]);

    /* ----- what this window knows about the task (used to detect edit conflicts) ----- */
    const inputs = { title, description: desc, priority: prio, due, assigneeId: assignee };
    const read = (f) => (f === 'title' || f === 'description' ? inputs[f].value.trim() : inputs[f].value);
    const ctx = { id, baseRev: t.rev || 1, orig: normTask(t), origCol: t.columnId, notes: {}, removedByOther: false };
    const dirty = (f) => read(f) !== ctx.orig[f];
    const show = (f, v) => (v === '' ? '(empty)' : f === 'assigneeId' ? ((memberById(Number(v)) || {}).name || 'Unknown') : f === 'priority' ? PRIORITY_LABEL[v] : f === 'due' ? dueLabel(v) : v);

    function updateSave() {
      const n = Object.keys(ctx.notes).length;
      save.disabled = n > 0 || ctx.removedByOther;
      hint.hidden = n === 0;
    }
    function clearNote(f) { if (ctx.notes[f]) { ctx.notes[f].remove(); delete ctx.notes[f]; inputs[f].removeAttribute('aria-invalid'); } updateSave(); }
    function showNote(f, theirs, by) {
      if (ctx.notes[f]) ctx.notes[f].remove();
      const note = el('div', { class: 'conflict-note', role: 'alert' }, [
        el('p', {}, [el('strong', { text: by }), ' changed ' + FIELD_LABEL[f] + ' to ', el('em', { text: '“' + show(f, theirs).slice(0, 120) + '”' }), '. Yours is different.']),
        el('div', { class: 'row' }, [
          el('button', { type: 'button', class: 'btn sm', text: 'Use theirs', onclick: () => { inputs[f].value = theirs; ctx.orig[f] = theirs; clearNote(f); } }),
          el('button', { type: 'button', class: 'btn sm', text: 'Keep mine', onclick: () => { ctx.orig[f] = theirs; clearNote(f); } })
        ])
      ]);
      ctx.notes[f] = note;
      inputs[f].setAttribute('aria-invalid', 'true');
      inputs[f].closest('.field').append(note);
      updateSave();
    }

    // A teammate changed this task while the window is open.
    ctx.remote = function (task, changed, by) {
      ctx.baseRev = task.rev || ctx.baseRev;
      const n = normTask(task);
      (changed && changed.length ? changed : FIELDS).forEach((f) => {
        if (n[f] === ctx.orig[f] && !ctx.notes[f]) return;                          // nothing new
        if (!dirty(f) && !ctx.notes[f]) {                                           // I have not touched it: just update
          inputs[f].value = n[f]; ctx.orig[f] = n[f];
          const fld = inputs[f].closest('.field'); fld.classList.remove('updated'); void fld.offsetWidth; fld.classList.add('updated');
        } else if (read(f) === n[f]) { ctx.orig[f] = n[f]; clearNote(f); }          // we typed the same thing
        else showNote(f, n[f], by);                                                 // real conflict: let the person choose
      });
      if (Number(column.value) === ctx.origCol) column.value = String(task.columnId);
      ctx.origCol = task.columnId;
    };
    ctx.removed = function (by) {
      ctx.removedByOther = true; updateSave();
      form.prepend(el('p', { class: 'form-error', role: 'alert', text: by + ' deleted this task. You can close this window.' }));
    };
    ctx.comment = (c) => { if (!clist.querySelector('[data-id="' + c.id + '"]')) clist.append(commentEl(c, id, clist)); };
    ctx.uncomment = (cid) => {
      const li = clist.querySelector('[data-id="' + cid + '"]');
      if (li) li.remove();
      if (!clist.querySelector('.comment') && !clist.querySelector('.empty-c')) clist.append(el('li', { class: 'muted empty-c', text: 'No comments yet. Start the conversation.' }));
    };
    ctx.presence = function () {
      const others = state.online.filter((u) => u.id !== state.user.id && u.editing.includes(id));
      presenceNote.hidden = !others.length;
      presenceNote.textContent = others.length ? others.map((u) => u.name).join(', ') + (others.length === 1 ? ' also has' : ' also have') + ' this task open.' : '';
    };
    state.taskCtx = ctx;

    /* ----- closing: ask before throwing away edits ----- */
    let asking = false;
    const hasEdits = () => FIELDS.some(dirty) || Number(column.value) !== ctx.origCol;
    async function attemptClose() {
      if (!hasEdits() || ctx.removedByOther) return closeDialog();
      if (asking) return;
      asking = true;
      const discard = await confirmDialog({ title: 'Discard your changes?', message: 'You edited this task but did not save.', confirmText: 'Discard', danger: true });
      asking = false;
      if (discard) closeDialog();
    }

    /* ----- save: send only what I changed + the revision I was looking at ----- */
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (Object.keys(ctx.notes).length || ctx.removedByOther) return;
      const patch = {};
      FIELDS.forEach((f) => {
        if (!dirty(f)) return;
        patch[f] = f === 'assigneeId' ? (assignee.value === '' ? null : Number(assignee.value)) : f === 'due' ? (due.value || null) : read(f);
      });
      const newCol = Number(column.value);
      const colChanged = newCol !== ctx.origCol;
      if (!Object.keys(patch).length && !colChanged) return closeDialog();
      const v = Object.keys(patch).length ? V.task(patch, true) : { ok: true, value: {} };
      if (!v.ok) return showFieldErrors(form, v.errors);
      showFieldErrors(form, {});
      setBusy(save, true);
      try {
        if (Object.keys(patch).length) {
          const r = await tracked(() => window.Api.patch('/api/tasks/' + id, Object.assign({}, v.value, { baseRev: ctx.baseRev })));
          const local = taskById(id);
          if (local && (r.task.rev || 0) >= (local.rev || 0)) Object.assign(local, r.task);
          ctx.orig = normTask(r.task); ctx.baseRev = r.task.rev || ctx.baseRev;
        }
        if (colChanged && taskById(id)) {
          const end = state.board.tasks.filter((x) => x.columnId === newCol && x.id !== id).length;
          await tracked(() => window.Api.post('/api/tasks/' + id + '/move', { columnId: newCol, index: end }));
          applyMoveLocally(id, newCol, end); ctx.origCol = newCol;
        }
        closeDialog(); renderColumns(); toast('Task saved.', { type: 'success' });
      } catch (e) {
        setBusy(save, false);
        if (e.status === 401) return;
        if (e.status === 409 && e.conflicts) {
          // Someone changed one of the fields I edited. Nothing was saved. Show both versions and let me choose.
          const clash = e.conflicts.map((c) => c.field);
          ctx.remote(e.current, FIELDS.filter((f) => !clash.includes(f)), 'Someone else');
          ctx.baseRev = e.current.rev;
          const cur = normTask(e.current);
          e.conflicts.forEach((c) => {
            const f = c.field;
            if (read(f) === cur[f]) { ctx.orig[f] = cur[f]; clearNote(f); } else showNote(f, cur[f], c.by ? c.by.name : 'Someone else');   // the server tells us who
          });
          showFieldErrors(form, {}, (new Set(e.conflicts.map((c) => (c.by ? c.by.name : 'Someone else')))).size === 1 ? e.conflicts[0].by ? e.conflicts[0].by.name + ' changed this task while you were editing. Nothing was saved yet.' : 'Someone else changed this task while you were editing. Nothing was saved yet.' : 'Others changed this task while you were editing. Nothing was saved yet. For each highlighted field, choose which version to keep, then save again.');
          return;
        }
        if (e.status === 404) return ctx.removed('Someone');
        showFieldErrors(form, e.fields, e.fields ? null : msgOf(e) + (e.network ? ' Your changes are still here, so you can try again.' : ''));
      }
    });

    cform.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const v = V.comment({ body: cbox.value });
      if (!v.ok) return showFieldErrors(cform, v.errors);
      showFieldErrors(cform, {});
      setBusy(cbtn, true, 'Posting…');
      try {
        ckey = ckey || newKey();
        const r = await tracked(() => window.Api.post('/api/tasks/' + id + '/comments', v.value, { idem: ckey }));
        ckey = null;
        ctx.comment(r.comment);
        const lt = taskById(id); if (lt) lt.commentCount = Math.max(lt.commentCount || 0, clist.querySelectorAll('.comment').length); renderColumns();
        cbox.value = ''; setBusy(cbtn, false); cbox.focus();
      } catch (e) { setBusy(cbtn, false); if (e.status !== 401) showFieldErrors(cform, e.fields, e.fields ? null : msgOf(e) + (e.network ? ' Press Comment again to retry; it will not be posted twice.' : '')); }
    });

    openDialog(wrap, { wide: true, onClose: () => { state.openTaskId = null; state.taskCtx = null; postEditing(null); } });
    const dlg = $('dlg');
    dlgCancel = (ev) => { if (hasEdits() && !ctx.removedByOther) { ev.preventDefault(); attemptClose(); } };
    dlg.addEventListener('cancel', dlgCancel);
    title.focus();
    postEditing(id);
    ctx.presence();

    clist.replaceChildren(el('li', { class: 'muted', text: 'Loading comments…' }));
    try {
      const r = await window.Api.get('/api/tasks/' + id);
      if (state.taskCtx !== ctx) return;
      fillComments(clist, r.comments, id);
      ctx.baseRev = Math.max(ctx.baseRev, r.task.rev || 1);
    } catch (e) {
      clist.replaceChildren(el('li', { class: 'form-error' }, [msgOf(e) + ' ', el('button', { type: 'button', class: 'link', text: 'Retry', onclick: () => refreshOpenTask() })]));
    }
  }

  function fillComments(clist, comments, taskId) {
    clist.replaceChildren();
    if (!comments.length) clist.append(el('li', { class: 'muted empty-c', text: 'No comments yet. Start the conversation.' }));
    comments.forEach((c) => clist.append(commentEl(c, taskId, clist)));
  }

  function commentEl(c, taskId, clist) {
    const canDelete = c.author.id === state.user.id || isOwner();
    const li = el('li', { class: 'comment', dataset: { id: c.id } }, [
      avatar({ id: c.author.id, name: c.author.name }, 30),
      el('div', { class: 'c-body' }, [
        el('div', { class: 'c-head' }, [el('strong', { text: c.author.name }), el('span', { class: 'muted', text: timeAgo(c.createdAt) }),
          canDelete ? el('button', { type: 'button', class: 'link danger', text: 'Delete', 'aria-label': 'Delete comment by ' + c.author.name, onclick: async () => {
            try {
              await tracked(() => window.Api.del('/api/comments/' + c.id));
              li.remove(); const t = taskById(taskId); if (t) t.commentCount = Math.max(0, t.commentCount - 1); renderColumns();
              if (!clist.querySelector('.comment')) clist.append(el('li', { class: 'muted empty-c', text: 'No comments yet. Start the conversation.' }));
            } catch (e) { if (e.status !== 401) toast('Could not delete the comment. ' + msgOf(e), { type: 'error' }); }
          } }) : null]),
        el('p', { class: 'c-text', text: c.body })
      ])
    ]);
    const empty = clist.querySelector('.empty-c'); if (empty) empty.remove();
    return li;
  }

  async function refreshOpenTask() {
    const id = state.openTaskId;
    const clist = $('dlg').querySelector('.comments');
    if (!id || !clist) return;
    try {
      const r = await window.Api.get('/api/tasks/' + id);
      fillComments(clist, r.comments, id);
      if (state.taskCtx && state.taskCtx.id === id) state.taskCtx.remote(r.task, null, 'Someone else');
    } catch (e) { if (e.status === 404 && state.taskCtx) state.taskCtx.removed('Someone else'); }
  }

  async function deleteTask(t) {
    const ok = await confirmDialog({ title: 'Delete this task?', message: '"' + t.title + '" and its comments will be deleted. This cannot be undone.', confirmText: 'Delete task', danger: true });
    if (!ok) return;
    try {
      await tracked(() => window.Api.del('/api/tasks/' + t.id));
      state.board.tasks = state.board.tasks.filter((x) => x.id !== t.id);
      state.openTaskId = null; closeDialog(); renderColumns(); toast('Task deleted.', { type: 'success' });
    } catch (e) { if (e.status !== 401) toast('Could not delete the task. ' + msgOf(e), { type: 'error' }); }
  }

  /* =============== start =============== */
  window.addEventListener('offline', () => { $('offline').hidden = false; });
  window.addEventListener('online', () => { $('offline').hidden = true; toast('You are back online.', { type: 'success' }); });
  if (!navigator.onLine) $('offline').hidden = false;

  (async function init() {
    try { state.user = (await window.Api.get('/api/auth/me', { noAuthRedirect: true })).user; }
    catch (e) {
      state.user = null;
      if (e.network) { view.replaceChildren(errorState('Cannot reach the server', msgOf(e), () => location.reload())); return; }
    }
    route();
  })();
})();
