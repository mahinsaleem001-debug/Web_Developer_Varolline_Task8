/* Small UI helpers: element builder, icons, toasts, confirm dialog, avatars, dates.
   Everything user-supplied is inserted with textContent, never innerHTML. */
(function (w) {
  'use strict';
  const SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach((k) => {
      const v = a[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style') Object.assign(n.style, v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'draggable' || k === 'required') n[k] = v;
      else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(children || []).forEach((c) => { if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return n;
  }

  const PATHS = {
    plus: 'M12 5v14M5 12h14', x: 'M6 6l12 12M18 6L6 18', trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3',
    users: 'M16 19v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 10a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 19v-1a4 4 0 00-3-3.9M16 3.1a3.5 3.5 0 010 6.8',
    more: 'M5 12h.01M12 12h.01M19 12h.01', chat: 'M21 12a8 8 0 01-11.6 7.1L4 20l1-4.6A8 8 0 1121 12z',
    calendar: 'M7 3v3M17 3v3M4 9h16M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
    moon: 'M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z', sun: 'M12 16a4 4 0 100-8 4 4 0 000 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    logout: 'M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9', back: 'M15 18l-6-6 6-6',
    search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM21 21l-4.3-4.3', edit: 'M4 20h4L19 9a2.8 2.8 0 00-4-4L4 16v4z', check: 'M5 12l5 5L20 7',
    grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01', alert: 'M12 8v5m0 3.5v.01M10.3 3.9L2.5 17.5A2 2 0 004.2 20.5h15.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    layout: 'M4 5h4a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zM16 5h4a1 1 0 011 1v6a1 1 0 01-1 1h-4a1 1 0 01-1-1V6a1 1 0 011-1zM10 5h4a1 1 0 011 1v9a1 1 0 01-1 1h-4a1 1 0 01-1-1V6a1 1 0 011-1z'
  };
  function icon(name, size) {
    const s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size || 18); s.setAttribute('height', size || 18);
    s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', PATHS[name] || ''); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }

  /* ---------- toasts ---------- */
  function toast(message, o) {
    const opts = o || {};
    const type = opts.type || 'info';
    const box = document.getElementById('toasts');
    const t = el('div', { class: 'toast ' + type, role: type === 'error' ? 'alert' : 'status' });
    t.append(icon(type === 'error' ? 'alert' : type === 'success' ? 'check' : 'chat', 18), el('span', { class: 'toast-msg', text: message }));
    function close() { clearTimeout(timer); t.remove(); }
    if (opts.action) {
      t.append(el('button', { type: 'button', class: 'toast-action', text: opts.action.label, onclick: () => { close(); opts.action.onClick(); } }));
    }
    t.append(el('button', { type: 'button', class: 'toast-x', 'aria-label': 'Dismiss', onclick: close }, icon('x', 14)));
    box.append(t);
    while (box.children.length > 4) box.firstChild.remove();
    const timer = setTimeout(close, opts.duration || (type === 'error' ? 9000 : 3500));
    return close;
  }

  /* ---------- confirm dialog (returns a Promise<boolean>) ---------- */
  function confirmDialog(o) {
    const dlg = document.getElementById('confirm');
    return new Promise((resolve) => {
      const ok = el('button', { type: 'button', class: 'btn ' + (o.danger ? 'danger' : 'primary'), text: o.confirmText || 'Confirm' });
      const cancel = el('button', { type: 'button', class: 'btn', text: 'Cancel' });
      dlg.replaceChildren(
        el('h2', { text: o.title }),
        el('p', { class: 'muted', text: o.message }),
        el('div', { class: 'dlg-actions' }, [cancel, ok])
      );
      let result = false;
      const finish = () => { dlg.removeEventListener('close', finish); resolve(result); };
      dlg.addEventListener('close', finish);
      ok.addEventListener('click', () => { result = true; dlg.close(); });
      cancel.addEventListener('click', () => dlg.close());
      dlg.showModal();
      cancel.focus();
    });
  }

  /* ---------- avatars ---------- */
  const COLORS = ['#0f766e', '#4338ca', '#b45309', '#be185d', '#15803d', '#7c3aed', '#0369a1', '#c2410c'];
  function initials(name) {
    const p = String(name || '?').trim().split(/\s+/);
    return ((p[0] || '?')[0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
  }
  function avatar(user, size) {
    const a = el('span', { class: 'avatar', title: user ? user.name : 'Unassigned', text: user ? initials(user.name) : '?' });
    a.style.background = user ? COLORS[user.id % COLORS.length] : 'var(--muted)';
    if (size) { a.style.width = a.style.height = size + 'px'; a.style.fontSize = Math.round(size * 0.4) + 'px'; }
    return a;
  }

  /* ---------- dates ---------- */
  const todayISO = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  function dueLabel(iso) {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(iso + 'T00:00:00Z'));
  }
  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 7 * 86400) return Math.round(s / 86400) + ' d ago';
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
  }

  w.UI = { el, icon, toast, confirmDialog, avatar, initials, todayISO, dueLabel, timeAgo };
})(window);
