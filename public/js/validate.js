/* Validation rules shared by the browser (window.Validate) and the server (require).
   Every function returns { ok, errors: { field: message }, value } so both sides show the same messages. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Validate = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const PRIORITIES = ['low', 'medium', 'high'];
  const DATE = /^\d{4}-\d{2}-\d{2}$/;

  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const done = (errors, value) => ({ ok: Object.keys(errors).length === 0, errors, value });

  function text(errors, field, v, label, min, max) {
    const s = str(v);
    if (s.length < min) errors[field] = min === 1 ? label + ' is required.' : label + ' must be at least ' + min + ' characters.';
    else if (s.length > max) errors[field] = label + ' must be at most ' + max + ' characters.';
    return s;
  }

  function isRealDate(s) {
    if (!DATE.test(s)) return false;
    const d = new Date(s + 'T00:00:00Z');
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }

  function signup(input) {
    const e = {};
    const name = text(e, 'name', input.name, 'Name', 2, 50);
    const email = str(input.email).toLowerCase();
    if (!EMAIL.test(email) || email.length > 120) e.email = 'Enter a valid email address.';
    const password = typeof input.password === 'string' ? input.password : '';
    if (password.length < 8) e.password = 'Password must be at least 8 characters.';
    else if (password.length > 72) e.password = 'Password must be at most 72 characters.';
    else if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) e.password = 'Password needs at least one letter and one number.';
    return done(e, { name, email, password });
  }

  function login(input) {
    const e = {};
    const email = str(input.email).toLowerCase();
    if (!EMAIL.test(email)) e.email = 'Enter a valid email address.';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!password) e.password = 'Password is required.';
    return done(e, { email, password });
  }

  function board(input) {
    const e = {};
    const name = text(e, 'name', input.name, 'Board name', 1, 60);
    const description = str(input.description);
    if (description.length > 200) e.description = 'Description must be at most 200 characters.';
    return done(e, { name, description });
  }

  function column(input) {
    const e = {};
    const name = text(e, 'name', input.name, 'List name', 1, 40);
    return done(e, { name });
  }

  // partial = true: only validate the fields that are present (used for PATCH).
  function task(input, partial) {
    const e = {}, v = {};
    const has = (k) => !partial || Object.prototype.hasOwnProperty.call(input, k);
    if (has('title')) v.title = text(e, 'title', input.title, 'Title', 1, 120);
    if (has('description')) {
      v.description = str(input.description);
      if (v.description.length > 2000) e.description = 'Description must be at most 2000 characters.';
    }
    if (has('priority')) {
      v.priority = input.priority === undefined && !partial ? 'medium' : input.priority;
      if (!PRIORITIES.includes(v.priority)) e.priority = 'Priority must be low, medium or high.';
    }
    if (has('due')) {
      const d = input.due === undefined || input.due === null || input.due === '' ? null : input.due;
      if (d !== null && !(typeof d === 'string' && isRealDate(d))) e.due = 'Due date must be a real date (YYYY-MM-DD).';
      v.due = d;
    }
    if (has('assigneeId')) {
      const a = input.assigneeId === undefined || input.assigneeId === '' ? null : input.assigneeId;
      if (a !== null && !(Number.isInteger(a) && a > 0)) e.assigneeId = 'Assignee is invalid.';
      v.assigneeId = a;
    }
    return done(e, v);
  }

  function comment(input) {
    const e = {};
    const body = text(e, 'body', input.body, 'Comment', 1, 1000);
    return done(e, { body });
  }

  function member(input) {
    const e = {};
    const email = str(input.email).toLowerCase();
    if (!EMAIL.test(email)) e.email = 'Enter a valid email address.';
    return done(e, { email });
  }

  return { signup, login, board, column, task, comment, member, PRIORITIES, isRealDate };
});
