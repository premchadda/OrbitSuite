import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {formCommand, formCallback, formAnswer} from '../src/owner_forms.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  const sent = [];
  let clock = 1764000000;
  const helpers = {ownerId: '123456', now: () => clock,
    query: (sql, ...args) => ({
      first: async () => db.prepare(sql).get(...args),
      all: async () => ({results: db.prepare(sql).all(...args)}),
      run: async () => ({meta: {changes: db.prepare(sql).run(...args).changes}}),
    }),
    telegram: async (method, body) => {sent.push({method, body});},
  };
  const command = (name, ...args) => formCommand({}, name, args, helpers);
  const message = (text, from = 123456) => ({chat: {type: 'private', id: 123456},
    from: {id: from}, text});
  return {db, sent, helpers, command, message,
    advance: seconds => {clock += seconds;}, close: () => db.close()};
}

test('persistent owner forms use private callback and sequential text answers', async t => {
  const f = fixture(); t.after(f.close);
  assert.match((await f.command('/formnew', 'Project', '|', 'Current', 'priority?', '|', 'Deadline?')).text, /#1/);
  assert.match((await f.command('/formlist')).text, /Project/);
  const start = await f.command('/formopen', '1');
  assert.deepEqual(start.reply_markup.inline_keyboard[0][0],
    {text: 'Start form', callback_data: 'form:1:start'});
  assert.match(await formCallback('form:1:start', f.helpers), /Question 1\/2/);
  assert.equal(await formAnswer(f.message('Finish backend'), f.helpers), true);
  assert.match(f.sent.at(-1).body.text, /Question 2\/2/);
  assert.equal(await formAnswer(f.message('Friday'), f.helpers), true);
  assert.match(f.sent.at(-1).body.text, /completed/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_form_submissions').get().n, 1);
  assert.match((await f.command('/formresults', '1')).text, /Finish backend/);
  assert.match((await f.command('/formresults', '1')).text, /Deadline\?: Friday/);
  assert.match((await f.command('/formdelete', '1', 'CONFIRM')).text, /deleted/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_forms').get().n, 0);
});

test('forms reject outsiders, arbitrary callbacks, expired runs, oversize inputs and commands', async t => {
  const f = fixture(); t.after(f.close);
  assert.match((await f.command('/formnew', 'Q', '|', 'too', 'short')).text, /Forms:/);
  assert.match((await f.command('/formnew', 'Owner', '|', 'Question', 'one?', '|', 'Question', 'two?')).text, /saved/);
  await f.command('/formopen', '1');
  assert.equal(await formCallback('form:2:start', f.helpers), 'Form expired or replaced.');
  assert.equal(await formCallback('form:1:delete', f.helpers), null);
  assert.equal(await formAnswer(f.message('X', 999), f.helpers), false);
  assert.match(await formCallback('form:1:start', f.helpers), /Question 1/);
  assert.equal(await formAnswer(f.message('/status'), f.helpers), false);
  assert.equal(await formAnswer(f.message('A'.repeat(501)), f.helpers), true);
  assert.match(f.sent.at(-1).body.text, /1–500/);
  f.advance(1801);
  assert.equal(await formAnswer(f.message('hello'), f.helpers), true);
  assert.match(f.sent.at(-1).body.text, /expired/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM owner_form_submissions').get().n, 0);
});
