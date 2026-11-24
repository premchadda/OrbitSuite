import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import worker from '../src/index.js';

function fakeDb() {
  const database = new DatabaseSync(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const name of readdirSync(migrations).filter(file => /^\d+.*\.sql$/.test(file)).sort()) {
    database.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  const wrap = (sql, args) => ({
    run: async () => {
      const result = database.prepare(sql).run(...args);
      return {meta: {changes: result.changes}};
    },
    first: async () => database.prepare(sql).get(...args),
    all: async () => ({results: database.prepare(sql).all(...args)}),
  });
  return {
    internal: database,
    prepare: sql => ({bind: (...args) => wrap(sql, args)}),
    batch: async statements => Promise.all(statements.map(item => item.run())),
  };
}

const message = (chat, user, text) => ({
  message: {chat, from: {id: user}, text, message_id: 10},
});
const owner = text => message({id: 12345, type: 'private'}, 12345, text);
const incoming = extra => ({
  message: {
    chat: {id: -1001234567890, type: 'supergroup'},
    from: {id: 654321}, message_id: 501, message_thread_id: 12,
    document: {mime_type: 'application/pdf'}, ...extra,
  },
});
function event(body) {
  return new Request('https://worker.example/', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'SECRET'},
    body: JSON.stringify(body),
  });
}
const sourceId = '-1001234567890';
const destId = '-1009876543210';

test('owner configures a topic route, copies media without downloading it, and stops queue', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({method: String(url).split('/').at(-1), body: JSON.parse(options.body)});
    return Response.json({ok: true, result: {message_id: 99}});
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const route = '/route ' + sourceId + ' 12 ' + destId + ' 34 pdf copy';
  assert.equal((await worker.fetch(event(owner(route)), env)).status, 200);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM routes').get().n, 1);
  assert.equal(calls[0].method, 'sendMessage');

  assert.equal((await worker.fetch(event(incoming({})), env)).status, 200);
  // The same update, when resent by Telegram, is not duplicated in the queue.
  assert.equal((await worker.fetch(event(incoming({})), env)).status, 200);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  await worker.scheduled({}, env);
  assert.equal(calls.at(-1).method, 'copyMessage');
  assert.equal(calls.at(-1).body.message_thread_id, 34);
  assert.equal(calls.at(-1).body.message_id, 501);
  assert.equal(DB.internal.prepare('SELECT state FROM jobs').get().state, 'done');
  assert.equal(DB.internal.prepare("SELECT value FROM settings WHERE key='daily_count'").get().value, '1');

  // Protected content is not enqueued; after /stop all new intake is paused.
  await worker.fetch(event(incoming({message_id: 502, has_protected_content: true})), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  await worker.fetch(event(owner('/stop')), env);
  await worker.fetch(event(incoming({message_id: 503})), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
});

test('archive index captures metadata, supports owner search, and records destination ID', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    calls.push({method, body: JSON.parse(options.body)});
    return Response.json({ok: true, result: {message_id: 704}});
  };
  t.after(() => {globalThis.fetch = oldFetch;});
  await worker.fetch(event(owner('/route ' + sourceId + ' 12 ' + destId + ' 34 pdf copy')), env);
  await worker.fetch(event(incoming({document: {mime_type: 'application/pdf',
    file_name: 'Geometry_Notes.pdf', file_size: 10000}, caption: 'SSC CGL triangle'})), env);
  await worker.scheduled({}, env);
  const saved = DB.internal.prepare('SELECT * FROM archive_items').get();
  assert.equal(saved.filename, 'Geometry_Notes.pdf');
  assert.equal(saved.media_kind, 'pdf');
  assert.equal(saved.dest_message_id, 704);
  assert.equal(saved.caption_preview, 'SSC CGL triangle');
  await worker.fetch(event(owner('/find Geometry')), env);
  assert.match(calls.at(-1).body.text, /Geometry_Notes\.pdf/);
  await worker.fetch(event(owner('/find %')), env);
  assert.match(calls.at(-1).body.text, /Usage:|No matching/);
  await worker.fetch(event(owner('/library')), env);
  assert.match(calls.at(-1).body.text, /Geometry_Notes\.pdf/);
  for (const filter of ['/files type pdf', '/files source ' + sourceId,
    '/files topic ' + destId + ' 34', '/files date ' + new Date().toISOString().slice(0, 10),
    '/files name Geometry']) {
    await worker.fetch(event(owner(filter)), env);
    assert.match(calls.at(-1).body.text, /Geometry_Notes\.pdf/);
  }
  await worker.fetch(event(owner('/files date 2026-02-30')), env);
  assert.match(calls.at(-1).body.text, /Invalid UTC date/);
});

test('link range batches validate both URLs, route and 50-message limit', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const oldFetch = globalThis.fetch;
  const messages = [];
  globalThis.fetch = async (_url, options) => {
    messages.push(JSON.parse(options.body).text);
    return Response.json({ok: true, result: {message_id: 777}});
  };
  t.after(() => {globalThis.fetch = oldFetch;});
  DB.internal.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(sourceId, 0, destId, 4, 'all', 'copy');
  const first = 'https://t.me/c/1234567890/120';
  const last = 'https://t.me/c/1234567890/122';
  await worker.fetch(event(owner('/batchlinks 1 ' + first + ' ' + last)), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 3);
  await worker.fetch(event(owner('/batchlinks 1 ' + first + ' https://t.me/c/999999999/122')), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 3);
  await worker.fetch(event(owner('/batchlinks 1 ' + first + ' https://t.me/c/1234567890/200')), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 3);
});

test('topic creation calls Bot API only for owner and stores created ID', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const methods = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    methods.push({method, body: JSON.parse(options.body)});
    return Response.json({ok: true, result: method === 'createForumTopic'
      ? {message_thread_id: 123} : {message_id: 1}});
  };
  t.after(() => {globalThis.fetch = oldFetch;});
  await worker.fetch(event(owner('/topiccreate ' + destId + ' Maths Archive')), env);
  assert.deepEqual(methods.map(entry => entry.method), ['createForumTopic', 'sendMessage']);
  assert.equal(methods[0].body.name, 'Maths Archive');
  assert.equal(DB.internal.prepare('SELECT title FROM topics').get().title, 'Maths Archive');
  assert.match(methods.at(-1).body.text, /123/);
});

test('sender and media size filters are configurable by owner', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ok: true, result: {message_id: 1}});
  t.after(() => {globalThis.fetch = oldFetch;});
  DB.internal.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(sourceId, 12, destId, 34, 'pdf', 'copy');
  await worker.fetch(event(owner('/sender 1 654321')), env);
  await worker.fetch(event(owner('/filesize 1 500 2000')), env);
  await worker.fetch(event(incoming({document: {mime_type: 'application/pdf', file_size: 1000}})), env);
  await worker.fetch(event(incoming({message_id: 502,
    document: {mime_type: 'application/pdf', file_size: 3000}})), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  await worker.fetch(event(owner('/sender 1 clear')), env);
  await worker.fetch(event(owner('/filesize 1 clear')), env);
  const route = DB.internal.prepare('SELECT * FROM routes WHERE id=1').get();
  assert.equal(route.sender_id, null);
  assert.equal(route.min_bytes, null);
});

test('one authorized source can fan out to two destinations without duplicate delivery', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const sent = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    if (method === 'copyMessage') sent.push(JSON.parse(options.body).chat_id);
    return Response.json({ok: true, result: {message_id: 50}});
  };
  t.after(() => {globalThis.fetch = oldFetch;});
  const secondDest = '-1007777777777';
  DB.internal.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(sourceId, 12, destId, 34, 'all', 'copy');
  DB.internal.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(sourceId, 12, secondDest, 0, 'all', 'copy');
  await worker.fetch(event(incoming({})), env);
  await worker.fetch(event(incoming({})), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM jobs').get().n, 2);
  await worker.scheduled({}, env);
  await worker.scheduled({}, env);
  assert.deepEqual(sent.sort(), [destId, secondDest].sort());
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM archive_items').get().n, 2);
});

test('opt-in group moderation is owner-only, supports replies, and protects owner', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({method: String(url).split('/').at(-1), body: JSON.parse(options.body)});
    return Response.json({ok: true, result: true});
  };
  t.after(() => {globalThis.fetch = oldFetch;});
  const group = {id: -1001234567890, type: 'supergroup'};
  const moderation = (from, text, target = 7654321098765) => event({message: {
    chat: group, from: {id: from}, text, message_id: 500,
    message_thread_id: 12, reply_to_message: {from: {id: target}, message_id: 400},
  }});
  await worker.fetch(moderation(12345, '/ban'), env);
  assert.equal(calls.length, 0);
  await worker.fetch(event(owner('/feature group_admin on')), env);
  calls.length = 0;
  await worker.fetch(moderation(9999, '/ban'), env);
  assert.equal(calls.length, 0);
  await worker.fetch(moderation(12345, '/ban'), env);
  assert.deepEqual(calls.map(c => c.method), ['banChatMember', 'sendMessage']);
  assert.equal(calls[0].body.user_id, 7654321098765);
  calls.length = 0;
  await worker.fetch(moderation(12345, '/mute 30'), env);
  assert.equal(calls[0].method, 'restrictChatMember');
  assert.equal(calls[0].body.user_id, 7654321098765);
  assert.equal(calls[0].body.until_date > Date.now() / 1000, true);
  calls.length = 0;
  await worker.fetch(moderation(12345, '/ban', 12345), env);
  assert.deepEqual(calls.map(c => c.method), ['sendMessage']);
  assert.match(calls[0].body.text, /owner is protected/);
});

test('Telegram rate limit requeues with a cooldown and never attempts instant retry', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const originalFetch = globalThis.fetch;
  let invoked = 0;
  globalThis.fetch = async () => {
    invoked++;
    return new Response(JSON.stringify({ok: false, error_code: 429, parameters: {retry_after: 90}}),
      {status: 429, headers: {'content-type': 'application/json'}});
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  DB.internal.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(sourceId, 0, destId, 0, 'all', 'copy');
  DB.internal.prepare('INSERT INTO jobs(route_id,message_id) VALUES(1,601)').run();
  await worker.scheduled({}, env);
  assert.equal(DB.internal.prepare('SELECT state FROM jobs').get().state, 'queued');
  assert.equal(DB.internal.prepare("SELECT value FROM settings WHERE key='cooldown'").get().value > Date.now() / 1000, true);
  await worker.scheduled({}, env);
  assert.equal(invoked, 1);
});
test('manual /save of an accessible Telegram post uses the zero-media queue', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const sends = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sends.push({method: String(url).split('/').at(-1), body: JSON.parse(options.body)});
    return Response.json({ok: true, result: {message_id: 88}});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  await worker.fetch(event(owner('/setarchive ' + destId + ' 34')), env);
  await worker.fetch(event(owner('/save https://t.me/c/1234567890/12/502')), env);
  await worker.fetch(event(owner('/save https://t.me/c/1234567890/12/502')), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM manual_jobs').get().n, 1);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM routes').get().n, 0);
  await worker.scheduled({}, env);
  assert.equal(sends.at(-1).method, 'copyMessage');
  assert.equal(sends.at(-1).body.from_chat_id, sourceId);
  assert.equal(sends.at(-1).body.message_thread_id, 34);
  assert.equal(sends.at(-1).body.message_id, 502);
  assert.equal(DB.internal.prepare('SELECT state FROM manual_jobs').get().state, 'done');
});
test('/id answers only the owner in the same forum topic', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const sends = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sends.push({method: String(url).split('/').at(-1), body: JSON.parse(options.body)});
    return Response.json({ok: true, result: {}});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  const group = {id: -1001234567890, type: 'supergroup'};
  await worker.fetch(event({message: {...message(group, 55555, '/id').message, message_thread_id: 7}}), env);
  assert.equal(sends.length, 0);
  await worker.fetch(event({message: {...message(group, 12345, '/id').message, message_thread_id: 7}}), env);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].body.message_thread_id, 7);
  assert.match(sends[0].body.text, /Topic: 7/);
});
test('manual save access denial is failed once and never retried automatically', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ok: false, error_code: 403, description: 'Forbidden'}),
      {status: 403, headers: {'content-type': 'application/json'}});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  DB.internal.prepare('INSERT INTO manual_jobs(source,dest,dest_topic,message_id) VALUES(?,?,?,?)')
    .run(sourceId, destId, 4, 100);
  await worker.scheduled({}, env);
  assert.equal(DB.internal.prepare('SELECT state FROM manual_jobs').get().state, 'failed');
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM routes').get().n, 0);
  await worker.scheduled({}, env);
  assert.equal(calls, 1);
});
test('/checkroute inspects bot membership without sending any archived message', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    calls.push({method, body: JSON.parse(options.body)});
    const result = method === 'getMe' ? {id: 777}
      : method === 'getChatMember' ? {status: 'administrator'} : {message_id: 1};
    return Response.json({ok: true, result});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  DB.internal.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(sourceId, 12, destId, 34, 'all', 'copy');
  await worker.fetch(event(owner('/checkroute 1')), env);
  assert.deepEqual(calls.map(call => call.method), ['getMe', 'getChatMember', 'getChatMember', 'sendMessage']);
  assert.equal(calls[1].body.user_id, 777);
  assert.equal(calls[2].body.user_id, 777);
  assert.match(calls[3].body.text, /Destination: administrator/);
});
test('opt-in media queue can be claimed and completed only by authenticated service', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {
    DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345',
    WEBHOOK_SECRET: 'SECRET', MEDIA_WORKER_KEY: 'TEST_LONG_PRIVATE_WORKER_KEY',
  };
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ok: true, result: {message_id: 1}});
  t.after(() => { globalThis.fetch = oldFetch; });
  await worker.fetch(event(owner('/setarchive ' + destId + ' 34')), env);
  await worker.fetch(event(owner('/feature media_downloads on')), env);
  await worker.fetch(event(owner('/dlq 720 https://www.youtube.com/watch?v=abc')), env);
  await worker.fetch(event(owner('/dlq 9999 https://www.youtube.com/watch?v=abc')), env);
  assert.equal(DB.internal.prepare('SELECT count(*) AS n FROM media_jobs').get().n, 1);
  const claim = (secret) => new Request('https://worker.example/internal/media/claim', {
    method: 'POST', headers: {'X-Orbit-Service-Key': secret}, body: '{}',
  });
  assert.equal((await worker.fetch(claim('WRONG'), env)).status, 403);
  const response = await worker.fetch(claim('TEST_LONG_PRIVATE_WORKER_KEY'), env);
  const result = await response.json();
  assert.equal(result.job.kind, 'video');
  assert.equal(result.job.dest_topic, 34);
  assert.equal(result.job.url, 'https://www.youtube.com/watch?v=abc');
  assert.equal(result.job.quality, '720');
  assert.equal((await (await worker.fetch(claim('TEST_LONG_PRIVATE_WORKER_KEY'), env)).json()).job, null);
  const done = await worker.fetch(new Request('https://worker.example/internal/media/result', {
    method: 'POST', headers: {
      'X-Orbit-Service-Key': 'TEST_LONG_PRIVATE_WORKER_KEY',
      'content-type': 'application/json',
    }, body: JSON.stringify({id: result.job.id, status: 'done'}),
  }), env);
  assert.equal((await done.json()).updated, true);
  assert.equal(DB.internal.prepare('SELECT state FROM media_jobs').get().state, 'done');
});
test('owner opt-in reminder is delivered once via the scheduled trigger', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({method: String(url).split('/').at(-1), body: JSON.parse(options.body)});
    return Response.json({ok: true, result: {message_id: 1}});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  await worker.fetch(event(owner('/feature reminders on')), env);
  await worker.fetch(event(owner('/remind 1 Revise algebra')), env);
  DB.internal.prepare("UPDATE reminders SET due=0 WHERE state='queued'").run();
  const before = calls.length;
  await worker.scheduled({}, env);
  assert.equal(calls.length, before + 1);
  assert.match(calls.at(-1).body.text, /Revise algebra/);
  assert.equal(DB.internal.prepare('SELECT state FROM reminders').get().state, 'done');
  await worker.scheduled({}, env);
  assert.equal(calls.length, before + 1);
});
test('group admin command requires owner and explicit feature toggle', async t => {
  const DB = fakeDb();
  t.after(() => DB.internal.close());
  const env = {DB, BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'SECRET'};
  const methods = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    methods.push(String(url).split('/').at(-1));
    return Response.json({ok: true, result: true});
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  const chat = {type: 'supergroup', id: -1001234567890};
  const pin = user => ({message: {...message(chat, user, '/pin').message,
    reply_to_message: {message_id: 44}}});
  await worker.fetch(event(pin(12345)), env);
  assert.equal(methods.includes('pinChatMessage'), false);
  await worker.fetch(event(owner('/feature group_admin on')), env);
  await worker.fetch(event(pin(999)), env);
  assert.equal(methods.includes('pinChatMessage'), false);
  await worker.fetch(event(pin(12345)), env);
  assert.equal(methods.includes('pinChatMessage'), true);
});
