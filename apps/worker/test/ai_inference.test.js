import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../../local/src/store.js';
import {handlePersonalCommand} from '../src/personal_extensions.js';
import {ollamaEndpoint, runTextInference} from '../src/ai_inference.js';

function fixture(t) {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  const env = {DB, ORBIT_AI_BASE_URL: 'http://127.0.0.1:11434', ORBIT_AI_MODEL: 'test-small-model'};
  const helpers = {
    ownerId: '12345', now: () => 1_700_000_000,
    query: (sql, ...args) => DB.prepare(sql).bind(...args),
    rows: async (sql, ...args) => (await DB.prepare(sql).bind(...args).all()).results,
  };
  const command = (name, ...args) => handlePersonalCommand(env, name, args, helpers);
  return {DB, env, helpers, command};
}

test('AI endpoint is fixed, rejects credentialed/private arbitrary URL and unbounded outputs', async () => {
  assert.equal(ollamaEndpoint({ORBIT_AI_BASE_URL: 'http://127.0.0.1:11434'}),
    'http://127.0.0.1:11434/api/generate');
  for (const value of ['http://192.168.1.15:11434', 'http://example.com',
    'https://user:password@example.com', 'https://example.com/evil', 'http://localhost:8000']) {
    assert.equal(ollamaEndpoint({ORBIT_AI_BASE_URL: value}), null, value);
  }
  const env = {ORBIT_AI_BASE_URL: 'https://trusted.example.com', ORBIT_AI_MODEL: 'safe-model'};
  let calls = 0;
  await assert.rejects(runTextInference(env, 'summary', 'Sample source text', async (_url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).stream, false);
    assert.ok(options.signal);
    return Response.json({response: 'x'.repeat(18000)});
  }), /too large/);
  assert.equal(calls, 1);
  await assert.rejects(runTextInference(env, 'execute', 'Run commands'), /invalid/);
});

test('AI inference requires explicit owner flag; offline fallbacks do not access provider', async t => {
  const {DB, helpers, command} = fixture(t);
  let calls = 0;
  helpers.aiFetch = async (_url, options) => {
    calls++;
    const prompt = JSON.parse(options.body).prompt;
    return Response.json({response: prompt.includes('filename basename') ? '../Math Practice.pdf'
      : prompt.includes('Summarize') ? 'SSC practice questions and answers.'
        : 'ssc, maths, exam-prep'});
  };
  assert.match(await command('/smartname', 'SSC', 'CGL', 'PDF'), /Offline/);
  assert.equal(calls, 0);
  await DB.prepare('UPDATE feature_flags SET enabled=1 WHERE feature=?').bind('personal_ai').run();
  assert.match(await command('/smartname', 'SSC', 'CGL', 'PDF'), /AI filename suggestion/);
  assert.match(await command('/summarize', 'Practice', 'SSC', 'questions'), /AI summary/);
  assert.match(await command('/tag', 'SSC', 'Maths'), /AI suggested tags: ssc, maths, exam-prep/);
  assert.equal(calls, 3);
});

test('explicit owner archive tags persist, search and remove without media downloads', async t => {
  const {DB, helpers, command} = fixture(t);
  await DB.prepare('INSERT INTO archive_items(source,source_message_id,dest,dest_topic,media_kind,filename,saved_at) '
    + 'VALUES(?,?,?,?,?,?,?)').bind('-1001234567890', 77, '-1009876543210', 12,
      'pdf', 'SSC_CGL_Maths.pdf', 1_700_000_000).run();
  const first = await command('/tagarchive', '1', 'auto');
  assert.match(first, /tags saved/);
  assert.match(await command('/tags', '1'), /ssc/);
  await command('/tagarchive', '1', 'exam-prep,reasoning');
  assert.match(await command('/tagsearch', 'reasoning'), /SSC_CGL_Maths/);
  assert.equal((await DB.prepare('SELECT count(*) AS n FROM archive_tags').bind().first()).n, 5);
  await command('/tagremove', '1', 'reasoning');
  assert.match(await command('/tagsearch', 'reasoning'), /No archive/);
  assert.match(await command('/tagarchive', '999', 'auto'), /not found/);
  assert.match(await command('/tagarchive', '1', '!!!'), /No valid tags/);
  assert.ok(helpers);
});
