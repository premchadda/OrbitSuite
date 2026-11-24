import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../../local/src/store.js';
import worker from '../src/index.js';

const source = '-1001234567890';
const dest = '-1009876543210';

function webhook(update) {
  return new Request('https://example.test/hook', {
    method: 'POST',
    headers: {'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'TEST_SECRET'},
    body: JSON.stringify(update),
  });
}

function owner(text) {
  return {message: {chat: {id: 12345, type: 'private'}, from: {id: 12345}, message_id: 9, text}};
}

function group(message_id, extras = {}) {
  return {message: {
    chat: {id: Number(source), type: 'supergroup'},
    from: {id: 23456}, message_id, message_thread_id: 7,
    date: Math.floor(Date.now() / 1000), text: 'Study text', ...extras,
  }};
}

function prepare(t) {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  const env = {DB, OWNER_ID: '12345', BOT_TOKEN: 'FAKE', WEBHOOK_SECRET: 'TEST_SECRET'};
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const method = String(url).split('/').at(-1);
    const body = JSON.parse(opts.body);
    calls.push({method, body});
    return Response.json({ok: true, result: method === 'createForumTopic'
      ? {message_thread_id: 77} : {message_id: 99}});
  };
  t.after(() => {globalThis.fetch = originalFetch;});
  return {DB, env, calls};
}

test('owner route commands, mapped topics, reply context and edit propagation integrate', async t => {
  const {DB, env, calls} = prepare(t);
  const send = async data => worker.fetch(webhook(data), env);
  await send(owner('/route ' + source + ' 0 ' + dest + ' 0 all copy'));
  await send(owner('/autotopics 1 on'));
  await send(owner('/topicsync 1 on'));
  await send(owner('/editsync 1 on'));
  await send(group(101, {forum_topic_created: {name: 'Exam preparation'}, text: undefined}));
  await send(group(102, {text: 'First study message'}));
  assert.equal(calls.filter(call => call.method === 'createForumTopic').length, 1);
  await worker.scheduled({}, env);
  const copied = calls.find(call => call.method === 'copyMessage');
  assert.equal(copied.body.message_thread_id, 77);
  assert.equal(DB._raw.prepare('SELECT dest_topic FROM archive_items WHERE source_message_id=102').get().dest_topic, 77);
  await send(group(103, {text: 'Reply', reply_to_message: {message_id: 102}}));
  await worker.scheduled({}, env);
  const replyCopy = calls.filter(call => call.method === 'copyMessage').at(-1);
  assert.deepEqual(replyCopy.body.reply_parameters, {message_id: 99});
  const edited = group(102, {text: 'Revised source text'});
  await send({edited_message: edited.message});
  assert.equal(calls.at(-1).method, 'editMessageText');
  assert.equal(calls.at(-1).body.message_id, 99);
  assert.equal(calls.at(-1).body.text, 'Revised source text');
});

test('opt-in moderation blocks configured messages before archiving; default is inert', async t => {
  const {DB, env, calls} = prepare(t);
  const send = async data => worker.fetch(webhook(data), env);
  await send(owner('/route ' + source + ' 0 ' + dest + ' 0 all copy'));
  await send(group(201, {text: 'Do not archive this word: xyzspam'}));
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  await send(owner('/modchat ' + source + ' on'));
  await send(owner('/modterm ' + source + ' add xyzspam'));
  await send(owner('/adminfeature moderation on'));
  await send(group(202, {text: 'contains xyzspam'}));
  assert.equal(calls.at(-1).method, 'deleteMessage');
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM jobs').get().n, 1);
  assert.equal(DB._raw.prepare('SELECT blocked FROM admin_moderation_seen WHERE message_id=202').get().blocked, 1);
  await send(group(202, {text: 'contains xyzspam'}));
  assert.equal(calls.filter(call => call.method === 'deleteMessage').length, 1);
});

test('read-only dashboard is separately opt-in and key-protected', async t => {
  const {env} = prepare(t);
  env.ORBIT_DASHBOARD_KEY = 'independent-test-key-at-least-24-characters';
  const fetchAdmin = (path, key) => worker.fetch(new Request('https://example.test' + path,
    {headers: key ? {Authorization: 'Bearer ' + key} : {}}), env);
  assert.equal((await fetchAdmin('/admin/api')).status, 404);
  await worker.fetch(webhook(owner('/adminfeature dashboard on')), env);
  assert.equal((await fetchAdmin('/admin/api')).status, 403);
  const response = await fetchAdmin('/admin/api', env.ORBIT_DASHBOARD_KEY);
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.ok('routes' in report.stats);
  assert.ok(Array.isArray(report.archive));
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('Telegram Mini App and private multi-question forms integrate through owner webhook', async t => {
  const {DB, env, calls} = prepare(t);
  env.ORBIT_PUBLIC_URL = 'https://bot.example.com';
  const send = async update => worker.fetch(webhook(update), env);
  await send(owner('/mini'));
  assert.match(calls.at(-1).body.text, /OFF/);
  await send(owner('/adminfeature dashboard on'));
  await send(owner('/mini'));
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].web_app.url,
    'https://bot.example.com/mini');
  await send(owner('/formnew Work | Main objective? | Completion date?'));
  await send(owner('/formopen 1'));
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[0][0].callback_data,
    'form:1:start');
  const outsider = {callback_query: {id: 'a', from: {id: 777},
    message: {chat: {id: 12345, type: 'private'}}, data: 'form:1:start'}};
  const before = calls.length;
  await send(outsider);
  assert.equal(calls.length, before);
  await send({callback_query: {id: 'b', from: {id: 12345},
    message: {chat: {id: 12345, type: 'private'}}, data: 'form:1:start'}});
  assert.match(calls.at(-2).body.text, /Question 1\/2/);
  await send(owner('Build OrbitSuite'));
  assert.match(calls.at(-1).body.text, /Question 2\/2/);
  await send(owner('This weekend'));
  assert.match(calls.at(-1).body.text, /completed/);
  await send(owner('/formresults 1'));
  assert.match(calls.at(-1).body.text, /Build OrbitSuite/);
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM owner_form_submissions').get().n, 1);
});

test('owner can configure a bounded media batch; authenticated worker reports progress without file bytes', async t => {
  const {DB, env} = prepare(t);
  env.MEDIA_WORKER_KEY = 'TEST_SERVICE_KEY';
  const send = async update => worker.fetch(webhook(update), env);
  const service = (path, body, token = env.MEDIA_WORKER_KEY) => worker.fetch(
    new Request('https://example.test/internal/media/' + path, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'X-Orbit-Service-Key': token},
      body: JSON.stringify(body),
    }), env);
  await send(owner('/setarchive ' + dest + ' 0'));
  await send(owner('/feature media_downloads on'));
  await send(owner('/mediabatch video https://example.com/first https://example.com/second'));
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM media_jobs').get().n, 1);
  await send(owner('/mediaoptions 1 {"height":720,"thumbnail":true,"compress_crf":26}'));
  assert.equal((await service('claim', {}, 'INVALID')).status, 403);
  const claimed = await (await service('claim', {})).json();
  assert.deepEqual(claimed.job.urls, ['https://example.com/first', 'https://example.com/second']);
  assert.deepEqual(claimed.job.options, {height: 720, thumbnail: true, compress_crf: 26});
  assert.equal((await service('progress', {id: 1, stage: 'upload', bytes: 100, total: 200,
    speed_bps: 20, eta_seconds: 5})).status, 200);
  assert.equal((await service('heartbeat', {id: 1})).status, 200);
  assert.equal(DB._raw.prepare('SELECT progress_bytes FROM media_jobs WHERE id=1').get().progress_bytes, 100);
  await send(owner('/mediajobs'));
  const complete = await service('result', {id: 1, status: 'done'});
  assert.equal(complete.status, 200);
  assert.equal((await service('progress', {id: 1, stage: 'upload'})).status, 409);
  assert.equal((await service('heartbeat', {id: 1})).status, 409);
});

test('private topic chooser displays observed topics and accepts only owner callbacks', async t => {
  const {DB, env, calls} = prepare(t);
  const send = async update => worker.fetch(webhook(update), env);
  await send(owner('/route ' + source + ' 0 ' + dest + ' 0 all copy'));
  DB._raw.prepare('INSERT INTO topics(chat,thread,title) VALUES(?,?,?)')
    .run(source, 12, 'SSC CGL preparation');
  DB._raw.prepare('INSERT INTO topics(chat,thread,title) VALUES(?,?,?)')
    .run(dest, 44, 'Archive study topic');
  await send(owner('/topicchoose 1 source'));
  const picker = calls.at(-1);
  assert.equal(picker.method, 'sendMessage');
  assert.equal(picker.body.reply_markup.inline_keyboard[1][0].callback_data, 'topic:1:s:12');
  const asCallback = (from, value) => ({callback_query: {
    id: 'test_callback', from: {id: from}, message: {chat: {id: 12345, type: 'private'}},
    data: value,
  }});
  await send(asCallback(34567, 'topic:1:s:12'));
  assert.equal(DB._raw.prepare('SELECT topic FROM routes WHERE id=1').get().topic, 0);
  await send(asCallback(12345, 'topic:1:s:999'));
  assert.match(calls.at(-1).body.text, /not observed/);
  await send(asCallback(12345, 'topic:1:s:12'));
  assert.equal(calls.at(-1).method, 'answerCallbackQuery');
  assert.equal(DB._raw.prepare('SELECT topic FROM routes WHERE id=1').get().topic, 12);
  await send(owner('/topicchoose 1 dest'));
  assert.equal(calls.at(-1).body.reply_markup.inline_keyboard[1][0].callback_data, 'topic:1:d:44');
  await send(asCallback(12345, 'topic:1:d:44'));
  assert.equal(DB._raw.prepare('SELECT dest_topic FROM routes WHERE id=1').get().dest_topic, 44);
  assert.equal(DB._raw.prepare("SELECT count(*) AS n FROM audit_events WHERE action='topic_selected'").get().n, 2);
});

test('moderator role has per-chat scope, daily quota and no promotion rights', async t => {
  const {env, DB, calls} = prepare(t);
  const send = async data => worker.fetch(webhook(data), env);
  await send(owner('/feature group_admin on'));
  await send(owner('/modchat ' + source + ' on'));
  await send(owner('/adminrole 23456 moderator'));
  await send(owner('/adminquota 23456 api 2'));
  await send(owner('/adminfeature roles on'));
  const delegated = (messageId, text, chatId = Number(source)) => ({message: {
    chat: {id: chatId, type: 'supergroup'}, from: {id: 23456}, message_id: messageId,
    text, reply_to_message: {message_id: 70, from: {id: 56789}},
  }});
  await send(delegated(301, '/pin'));
  await send(delegated(302, '/unpin'));
  await send(delegated(303, '/delete'));
  await send(delegated(304, '/promote'));
  await send(delegated(305, '/pin', -1006666666666));
  assert.deepEqual(calls.filter(x => ['pinChatMessage', 'unpinChatMessage', 'deleteMessage',
    'promoteChatMember'].includes(x.method)).map(x => x.method), ['pinChatMessage', 'unpinChatMessage']);
  assert.equal(DB._raw.prepare("SELECT used FROM admin_quota_usage WHERE user_id='23456' AND action='api'").get().used, 2);
  await send(owner('/adminfeature roles off'));
  await send(delegated(306, '/pin'));
  assert.equal(calls.filter(x => x.method === 'pinChatMessage').length, 1);
});

test('owner-submitted Telegram parts form a bounded join job without downloading in control plane', async t => {
  const {DB, env, calls} = prepare(t);
  env.MEDIA_WORKER_KEY = 'SERVICE_KEY_FOR_TEST';
  const send = update => worker.fetch(webhook(update), env);
  await send(owner('/feature media_downloads on'));
  const part = (message_id, filename, from = 12345) => ({message: {
    chat: {id: from, type: 'private'}, from: {id: from}, message_id,
    document: {file_name: filename, file_size: 6, file_id: 'ABCDEF1234567890_file_' + message_id},
  }});
  await send(part(50, 'lesson.pdf.part001', 22222)); // Non-owner cannot register files.
  await send(part(51, 'lesson.pdf.part001'));
  await send(part(52, 'lesson.pdf.part002'));
  await send(owner('/joinparts 2'));
  assert.match(calls.at(-1).body.text, /Join job #1 queued/);
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM media_part_inputs').get().n, 2);
  assert.equal(DB._raw.prepare('SELECT url FROM media_jobs WHERE id=1').get().url, 'telegram-parts://owner');
  const response = await worker.fetch(new Request('https://example.test/internal/media/claim', {
    method: 'POST', headers: {'X-Orbit-Service-Key': env.MEDIA_WORKER_KEY},
    body: '{}',
  }), env);
  assert.equal(response.status, 200);
  const job = (await response.json()).job;
  assert.deepEqual(job.parts.map(item => item.filename), ['lesson.pdf.part001', 'lesson.pdf.part002']);
  assert.equal(job.dest, env.OWNER_ID);
});

test('local transcription is owner-only, replied-to audio only and doubly opt-in', async t => {
  const {DB, env, calls} = prepare(t);
  env.MEDIA_WORKER_KEY = 'SERVICE_KEY_FOR_TEST';
  const send = update => worker.fetch(webhook(update), env);
  const request = {message: {chat: {id: 12345, type: 'private'}, from: {id: 12345},
    message_id: 50, text: '/transcribe', reply_to_message: {message_id: 48,
      voice: {file_id: 'VOICEFILEIDENTIFIER123456', file_size: 5000}}}};
  await send(request);
  assert.match(calls.at(-1).body.text, /OFF/);
  await send(owner('/feature media_downloads on'));
  await send(owner('/feature personal_transcription on'));
  await send({...request, message: {...request.message, reply_to_message: {
    voice: {file_id: 'VOICEFILEIDENTIFIER123456', file_size: 5000}, has_protected_content: true}}});
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM media_jobs').get().n, 0);
  await send(request);
  assert.match(calls.at(-1).body.text, /Transcription job #1 queued/);
  const claim = await worker.fetch(new Request('https://example.test/internal/media/claim', {
    method: 'POST', headers: {'X-Orbit-Service-Key': env.MEDIA_WORKER_KEY}, body: '{}',
  }), env);
  const job = (await claim.json()).job;
  assert.equal(job.task, 'transcribe');
  assert.equal(job.file_id, 'VOICEFILEIDENTIFIER123456');
  assert.equal(job.dest, env.OWNER_ID);
});
