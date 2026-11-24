import {test} from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../../local/src/store.js';
import worker from '../src/index.js';
import {
  safeRegex, matchesExtendedFilters, nextDeliveryTime, ensureMappedTopic,
  enqueueAlbumMessage, drainAlbum, mappedTopic, syncTopicTitle,
  createBatchRange, pumpBatchRange, saveRouteTemplate, applyRouteTemplate,
  propagateEditedMessage, deleteCopiedMessage, replyParameters,
  handleMessagingCommand, ingestMessagingUpdate, runMessagingScheduled,
} from '../src/messaging_extensions.js';

const source = '-1001234567890';
const dest = '-1009876543210';
const NOW = Math.floor(Date.parse('2026-11-24T12:00:00Z') / 1000);
const select = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const exec = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();
const sample = (id = 77, extras = {}) => ({
  chat: {id: source, type: 'supergroup'}, from: {id: 555},
  message_id: id, message_thread_id: 12, date: NOW,
  document: {mime_type: 'application/pdf', file_name: 'Study.PDF', file_size: 100},
  caption: 'Notes for SSC CGL', ...extras,
});

async function setup(t, extras = {}) {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  const env = {DB};
  await exec(env,
    'INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)',
    source, 0, dest, 34, 'all', 'copy');
  await exec(env, 'INSERT INTO settings(key,value) VALUES(?,?)', 'daily_day', '2026-11-24');
  await exec(env, 'INSERT INTO settings(key,value) VALUES(?,?)', 'daily_count', '0');
  const route = {...await select(env, 'SELECT * FROM routes WHERE id=1'), ...extras};
  return {env, route};
}

test('bounded regex accepts useful patterns and rejects catastrophic expressions', () => {
  assert.ok(safeRegex('^SSC.*2026$'));
  assert.ok(safeRegex('[a-z0-9]'));
  for (const invalid of ['(a+)+$', 'a+a+', 'a{1,100}', '(?<=a)b', 'a.*b.*c', 'a\\1', 'x'.repeat(97), '[abc', '^x?$']) {
    assert.equal(safeRegex(invalid), null, invalid);
  }
  assert.ok(safeRegex('^SSC.*2026$').test('SSC CGL prep 2026'));
});

test('extended MIME, extension, UTC date and safe text filters', async t => {
  const {route} = await setup(t);
  route.mime_csv = 'application/pdf,image/*';
  route.extension_csv = 'pdf,zip';
  route.regex_include = 'ssc.*cgl';
  route.regex_exclude = 'spoiler';
  route.date_from = '2026-11-01';
  route.date_to = '2026-11-30';
  assert.ok(matchesExtendedFilters(sample(), route));
  assert.equal(matchesExtendedFilters(sample(12, {caption: 'SSC spoiler CGL'}), route), false);
  assert.equal(matchesExtendedFilters(sample(12, {date: NOW - 90 * 86400}), route), false);
  assert.equal(matchesExtendedFilters(sample(12, {document: {mime_type: 'text/plain', file_name: 'Study.PDF'}}), route), false);
  assert.equal(matchesExtendedFilters(sample(12, {document: {mime_type: 'application/pdf', file_name: 'Study.EXE'}}), route), false);
  assert.equal(matchesExtendedFilters(sample(12, {has_protected_content: true}), route), false);
});

test('scheduling respects weekday and overnight UTC windows without dropping', async t => {
  const {route} = await setup(t);
  const tue = Math.floor(Date.parse('2026-11-24T12:00:00Z') / 1000);
  route.window_utc = '22:00-02:00';
  route.weekdays_csv = '2'; // Tuesday
  assert.equal(nextDeliveryTime(route, tue), tue + 10 * 3600);
  assert.equal(nextDeliveryTime(route, tue + 12 * 3600), tue + 12 * 3600);
  assert.equal(nextDeliveryTime(route, tue + 13 * 3600), tue + 13 * 3600);
  assert.equal(nextDeliveryTime(route, tue + 15 * 3600), tue + 7 * 86400 + 10 * 3600);
  assert.equal(nextDeliveryTime({...route, weekdays_csv: '8'}, tue), null);
  assert.equal(nextDeliveryTime({...route, window_utc: '26:00-30:00'}, tue), null);
});

test('forum topic creates exactly once, syncs title, never retries an ambiguous creation', async t => {
  const {env, route} = await setup(t, {auto_topics: 1, dest_topic: 0, sync_topic_titles: 1});
  let creates = 0;
  const calls = [];
  const api = async (method, body) => {
    calls.push([method, body]);
    if (method === 'createForumTopic') {creates++; return {message_thread_id: 119};}
    return true;
  };
  assert.equal(await ensureMappedTopic(env, route, 12, 'Study Group', api, NOW), 119);
  assert.equal(await ensureMappedTopic(env, route, 12, 'Study Group', api, NOW), 119);
  assert.equal(creates, 1);
  assert.equal(await mappedTopic(env, route.id, 12), 119);
  assert.equal(await syncTopicTitle(env, route, 12, 'New Group', api, NOW), true);
  assert.equal(calls.at(-1)[0], 'editForumTopic');
  assert.equal(await ensureMappedTopic(env, route, 14, 'Uncertain', async () => {throw new Error('timeout');}, NOW), null);
  assert.equal(await ensureMappedTopic(env, route, 14, 'Uncertain', api, NOW), null);
  assert.equal(creates, 1);
  assert.equal((await select(env, 'SELECT state FROM topic_mappings WHERE source_topic=14')).state, 'uncertain');
  await exec(env, "INSERT INTO topic_mappings(route_id,source_topic,title,state,updated_at) VALUES(?,?,?,?,?)",
    1, 99, 'Interrupted', 'creating', NOW - 600);
  await runMessagingScheduled(env, {now: () => NOW});
  assert.equal((await select(env, 'SELECT state FROM topic_mappings WHERE source_topic=99')).state, 'uncertain');
});

test('albums are batched in ascending order and archived with precise destination IDs', async t => {
  const {env, route} = await setup(t);
  for (const id of [101, 100, 102]) {
    const result = await enqueueAlbumMessage(env, route, sample(id, {media_group_id: 'album-A'}), {nowSeconds: NOW});
    assert.equal(result.handled, true);
  }
  await enqueueAlbumMessage(env, route, sample(101, {media_group_id: 'album-A'}), {nowSeconds: NOW});
  assert.equal((await select(env, 'SELECT count(*) AS n FROM album_members')).n, 3);
  const calls = [];
  const api = async (method, body) => {
    calls.push({method, body});
    return [{message_id: 201}, {message_id: 202}, {message_id: 203}];
  };
  assert.deepEqual(await drainAlbum(env, api, NOW + 3), {processed: false});
  assert.deepEqual(await drainAlbum(env, api, NOW + 5), {processed: true, state: 'done', count: 3});
  assert.equal(calls[0].method, 'copyMessages');
  assert.deepEqual(calls[0].body.message_ids, [100, 101, 102]);
  assert.equal(calls[0].body.message_thread_id, 34);
  const archived = (await env.DB.prepare('SELECT source_message_id,dest_message_id FROM archive_items ORDER BY source_message_id').bind().all()).results;
  assert.deepEqual(archived.map(x => [x.source_message_id, x.dest_message_id]), [[100, 201], [101, 202], [102, 203]]);
  assert.equal((await select(env, "SELECT value FROM settings WHERE key='daily_count'")).value, '3');
});

test('partial album responses and transport failures stay uncertain (never blind retry)', async t => {
  const {env, route} = await setup(t);
  await enqueueAlbumMessage(env, route, sample(100, {media_group_id: 'album1'}), {nowSeconds: NOW});
  await enqueueAlbumMessage(env, route, sample(101, {media_group_id: 'album1'}), {nowSeconds: NOW});
  assert.equal((await drainAlbum(env, async () => [{message_id: 300}], NOW + 10)).state, 'uncertain');
  assert.equal((await select(env, 'SELECT count(*) AS n FROM archive_items')).n, 0);
  assert.equal((await drainAlbum(env, async () => {throw new Error('should not retry');}, NOW + 20)).processed, false);
  await enqueueAlbumMessage(env, route, sample(102, {media_group_id: 'album2'}), {nowSeconds: NOW});
  assert.equal((await drainAlbum(env, async () => {throw new Error('network timeout');}, NOW + 10)).state, 'uncertain');
});

test('rate-limited albums are rescheduled, and daily budget caps actual message count', async t => {
  const {env, route} = await setup(t);
  await enqueueAlbumMessage(env, route, sample(100, {media_group_id: 'album1'}), {nowSeconds: NOW});
  const result = await drainAlbum(env, async () => {const e = new Error('429'); e.code=429; e.retry=90; throw e;}, NOW + 5);
  assert.equal(result.state, 'queued');
  assert.equal(result.cooldown, NOW + 95);
  await exec(env, "UPDATE settings SET value='200' WHERE key='daily_count'");
  assert.equal((await drainAlbum(env, async () => ({message_id: 777}), NOW + 96)).processed, false);
});

test('large historical known-ID ranges checkpoint in bounded chunks and deduplicate', async t => {
  const {env} = await setup(t);
  const batchId = await createBatchRange(env, 1, 100, 184, NOW);
  assert.ok(validPositiveIdForTest(batchId));
  assert.equal((await pumpBatchRange(env, NOW)).count, 40);
  assert.equal((await pumpBatchRange(env, NOW)).count, 40);
  assert.equal((await pumpBatchRange(env, NOW)).count, 5);
  assert.equal((await pumpBatchRange(env, NOW)).processed, false);
  assert.equal((await select(env, 'SELECT count(*) AS n FROM jobs')).n, 85);
  const batch = await select(env, 'SELECT * FROM batch_ranges WHERE id=?', batchId);
  assert.equal(batch.state, 'done');
  assert.equal(batch.next_id, 185);
  assert.equal(batch.enqueued_count, 85);
  assert.equal(await createBatchRange(env, 1, 1, 10001, NOW), null);
});

test('route templates copy settings without chat endpoints, and owner commands work', async t => {
  const {env, route} = await setup(t);
  assert.equal(await handleMessagingCommand(env, '/routepattern', ['1', 'include', 'SSC.*CGL']),
    'Safe regex filter saved for route #1.');
  assert.ok((await select(env, 'SELECT regex_include FROM routes WHERE id=1')).regex_include);
  assert.equal(await handleMessagingCommand(env, '/routepattern', ['1', 'include', '(a+)+']),
    'Invalid safe pattern: max 96 chars; no groups, backrefs, lookaround, or quantifiers except one .* wildcard.');
  assert.equal(await handleMessagingCommand(env, '/routefile', ['1', 'ext', 'pdf,zip']).then(s => /saved/.test(s)), true);
  assert.equal(await saveRouteTemplate(env, 'study', route.id, NOW), true);
  await exec(env, 'UPDATE routes SET regex_include=NULL,extension_csv=NULL WHERE id=1');
  assert.equal(await applyRouteTemplate(env, 'study', route.id), true);
  assert.equal((await select(env, 'SELECT regex_include FROM routes WHERE id=1')).regex_include, 'SSC.*CGL');
  assert.equal((await select(env, 'SELECT extension_csv FROM routes WHERE id=1')).extension_csv, 'pdf,zip');
  assert.equal(await handleMessagingCommand(env, '/routebatch', ['1','500','520']),
    'Checkpointed batch #1 queued: 21 known IDs. No source history will be scraped.');
  assert.match(await handleMessagingCommand(env, '/routebatches'), /0\/21/);
  assert.equal(await handleMessagingCommand(env, '/routebatchpause', ['1']), 'Batch #1 paused.');
  assert.equal(await handleMessagingCommand(env, '/routebatchresume', ['1']), 'Batch #1 queued.');
});

test('only confirmed, authorized archive mappings support reply, edit and deliberate delete', async t => {
  const {env, route} = await setup(t, {propagate_edits: 1});
  await exec(env,
    'INSERT INTO archive_items(source,source_message_id,dest,dest_topic,dest_message_id,route_id,media_kind,saved_at) VALUES(?,?,?,?,?,?,?,?)',
    source, 77, dest, 34, 999, route.id, 'pdf', NOW);
  assert.deepEqual(await replyParameters(env, route, sample(78, {reply_to_message: {message_id:77}})), {message_id:999});
  assert.equal(await replyParameters(env, route, sample(78, {reply_to_message: {message_id:77}}), 333), null);
  assert.equal(await replyParameters(env, route, sample(78, {reply_to_message: {message_id:99}})), null);
  const calls = [];
  const api = async (method, body) => { calls.push([method, body]); return true; };
  assert.equal(await propagateEditedMessage(env, sample(77, {caption: 'Updated'}), route, api), true);
  assert.equal(calls[0][0], 'editMessageCaption');
  assert.equal(calls[0][1].message_id, 999);
  assert.equal(await propagateEditedMessage(env, sample(89, {caption: 'Unknown'}), route, api), false);
  assert.equal(await deleteCopiedMessage(env, route.id, 77, api, NOW), true);
  assert.equal(calls[1][0], 'deleteMessage');
  assert.equal(await deleteCopiedMessage(env, route.id, 77, api, NOW), false);
  assert.equal(await replyParameters(env, route, sample(78, {reply_to_message: {message_id:77}})), null);
});

test('ingest helper includes topic, schedule, reply mapping; scheduler obeys emergency stop', async t => {
  const {env, route} = await setup(t);
  const result = await ingestMessagingUpdate(env, sample(77), route, {now: () => NOW});
  assert.equal(result.accepted, true);
  assert.equal(result.handled, false);
  assert.equal(result.destinationTopic, 34);
  assert.equal(result.due, NOW);
  await exec(env, 'INSERT INTO settings(key,value) VALUES(?,?)', 'stopped', '1');
  assert.equal((await ingestMessagingUpdate(env, sample(77), route, {now: () => NOW})).reason, 'stopped');
  assert.deepEqual(await runMessagingScheduled(env, {now: () => NOW}), {skipped:'stopped'});
});

test('Worker webhook and cron integrate album preserving copy, archive IDs, and owner commands', async t => {
  const {env} = await setup(t);
  Object.assign(env, {BOT_TOKEN: 'LOCAL_TEST_ONLY', OWNER_ID: '12345', WEBHOOK_SECRET: 'CHECK'});
  const oldFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const method = String(url).split('/').at(-1);
    calls.push({method, body: JSON.parse(options.body)});
    return Response.json({ok: true, result: method === 'copyMessages'
      ? [{message_id: 800}, {message_id: 801}] : {message_id: 899}});
  };
  t.after(() => {globalThis.fetch = oldFetch;});
  const post = update => new Request('https://example.workers.dev/', {
    method: 'POST', headers: {'content-type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'CHECK'},
    body: JSON.stringify(update),
  });
  assert.equal((await worker.fetch(post({message: {chat: {id:12345, type:'private'}, from:{id:12345},
    message_id:1, text:'/routefile 1 ext pdf'}}), env)).status, 200);
  assert.match(calls.at(-1).body.text, /saved/);
  await worker.fetch(post({message: sample(401, {media_group_id:'group_test'})}), env);
  await worker.fetch(post({message: sample(400, {media_group_id:'group_test'})}), env);
  await worker.fetch(post({message: sample(400, {media_group_id:'group_test'})}), env);
  assert.equal((await select(env, 'SELECT count(*) AS n FROM jobs')).n, 0);
  assert.equal((await select(env, 'SELECT count(*) AS n FROM album_members')).n, 2);
  await exec(env, "UPDATE album_batches SET due=0 WHERE state='queued'");
  await worker.scheduled({}, env);
  const copy = calls.find(c => c.method === 'copyMessages');
  assert.deepEqual(copy.body.message_ids, [400, 401]);
  assert.equal(copy.body.message_thread_id, 34);
  assert.equal((await select(env, 'SELECT count(*) AS n FROM archive_items')).n, 2);
  assert.equal((await select(env, "SELECT value FROM settings WHERE key='daily_count'")).value, '2');
});

function validPositiveIdForTest(n) { return Number.isSafeInteger(n) && n > 0; }
