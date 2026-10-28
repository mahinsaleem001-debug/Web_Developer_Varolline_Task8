'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../public/js/validate.js');

test('signup rules', () => {
  assert.equal(V.signup({ name: 'Ann Lee', email: 'ann@x.io', password: 'abcdefg1' }).ok, true);
  assert.equal(V.signup({ name: 'Ann Lee', email: 'ann@x.io', password: 'abcdefgh' }).errors.password.includes('number'), true);
  assert.ok(V.signup({ name: ' ', email: 'bad', password: '' }).errors.name);
  assert.equal(V.signup({ name: 'Ann', email: ' ANN@X.IO ', password: 'abcdefg1' }).value.email, 'ann@x.io');
});
test('task rules: full and partial', () => {
  assert.equal(V.task({ title: 'Hi' }, false).value.priority, 'medium', 'default priority');
  assert.ok(V.task({ title: 'Hi', due: '2026-02-30' }, false).errors.due);
  assert.equal(V.task({ due: '' }, true).value.due, null);
  assert.deepEqual(Object.keys(V.task({ priority: 'high' }, true).value), ['priority'], 'partial only checks given fields');
  assert.ok(V.task({ assigneeId: 'abc' }, true).errors.assigneeId);
  assert.ok(V.task({ title: 'x'.repeat(121) }, true).errors.title);
});
test('board, column, comment, member rules', () => {
  assert.ok(V.board({ name: '' }).errors.name);
  assert.ok(V.board({ name: 'ok', description: 'x'.repeat(201) }).errors.description);
  assert.ok(V.column({ name: 'x'.repeat(41) }).errors.name);
  assert.ok(V.comment({ body: '  ' }).errors.body);
  assert.ok(V.member({ email: 'nope' }).errors.email);
});
