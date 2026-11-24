import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {
  handleAdminCommand, handleAdminUpdate, handleAdminHttp, runAdminScheduled,
  checkAndConsumeQuota, checkAdminRole, checkRequiredMembership,
  renderRichMessage, createPaymentAdapter,
} from '../src/admin_extensions.js';
import {DASHBOARD_SCRIPT} from '../../dashboard/ui.js';

const GROUP = '-1001234567890';
const OTHER_GROUP = '-1001234567891';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).sort()
    .filter(name => /^(000[1-9]|0012).*\.sql$/.test(name))) {
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  let clock = 1_700_000_000;
  const sent = [];
  const env = {ORBIT_DASHBOARD_KEY: 'super-private-owner-password-1234567890'};
  const helpers = {
    ownerId: '12345', actorId: '12345', now: () => clock,
    query: (sql, ...args) => ({
      first: async () => db.prepare(sql).get(...args),
      all: async () => ({results: db.prepare(sql).all(...args)}),
      run: async () => ({meta: {changes: db.prepare(sql).run(...args).changes}}),
    }),
    rows: async (sql, ...args) => db.prepare(sql).all(...args),
    telegram: async (method, body) => {
      sent.push({method, body});
      return method === 'getChatMember' ? {status: 'member'} : {message_id: 777};
    },
  };
  const command = (name, ...args) => handleAdminCommand(env, name, args, helpers);
  const enable = name => db.prepare('UPDATE admin_feature_flags SET enabled=1 WHERE name=?').run(name);
  const groupMessage = (text, messageId = 1, additions = {}) => ({
    chat: {id: Number(GROUP), type: 'supergroup'}, from: {id: 7777},
    message_id: messageId, text, ...additions,
  });
  return {db, env, sent, helpers, command, enable, groupMessage,
    advance: seconds => { clock += seconds; }, close: () => db.close()};
}

test('feature switches start disabled, all owner commands require actor ID', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(await f.command('/something'), null);
  assert.match(await f.command('/adminfeatures'), /moderation: OFF/);
  assert.match(await f.command('/adminfeature', 'moderation', 'on'), /ON/);
  assert.equal(f.db.prepare('SELECT enabled FROM admin_feature_flags WHERE name=?').get('moderation').enabled, 1);
  f.helpers.actorId = '7777';
  assert.match(await f.command('/adminfeature', 'antiflood', 'on'), /owner-only/);
  assert.equal(f.db.prepare('SELECT enabled FROM admin_feature_flags WHERE name=?').get('antiflood').enabled, 0);
  f.helpers.actorId = undefined;
  assert.match(await f.command('/adminplans'), /owner-only/);
  assert.equal(await f.command('/notowned'), null);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_audit').get().n, 1);
});

test('blocklist moderation is scoped, opt-in, deduplicated and ignores owner messages', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/modchat', GROUP, 'on'), /ON/);
  assert.match(await f.command('/modterm', GROUP, 'add', 'unwanted', 'offer'), /added/);
  assert.deepEqual(await handleAdminUpdate(f.env, f.groupMessage('unwanted offer', 1), f.helpers), {blocked: false});
  f.enable('moderation');
  assert.deepEqual(await handleAdminUpdate(f.env, f.groupMessage('Unwanted OFFER', 2), f.helpers),
    {blocked: true, reason: 'keyword'});
  assert.deepEqual(f.sent, [{method: 'deleteMessage', body: {chat_id: Number(GROUP), message_id: 2}}]);
  assert.deepEqual(await handleAdminUpdate(f.env, f.groupMessage('Unwanted OFFER', 2), f.helpers),
    {blocked: true, duplicate: true});
  assert.equal(f.sent.length, 1);
  assert.deepEqual(await handleAdminUpdate(f.env,
    {...f.groupMessage('Unwanted OFFER', 3), chat: {id: Number(OTHER_GROUP), type: 'supergroup'}}, f.helpers),
    {blocked: false});
  assert.deepEqual(await handleAdminUpdate(f.env,
    f.groupMessage('Unwanted OFFER', 4, {from: {id: 12345}}), f.helpers), {blocked: false});
  assert.deepEqual(await handleAdminUpdate(f.env,
    f.groupMessage('Unwanted OFFER', 5, {sender_chat: {id: Number(GROUP)}}), f.helpers), {blocked: false});
  assert.equal(f.sent.length, 1);
});

test('anti-flood threshold applies per user and resets after window', async t => {
  const f = fixture(); t.after(f.close);
  await f.command('/modchat', GROUP, 'on');
  await f.command('/modrate', GROUP, '2', '10');
  f.enable('antiflood');
  assert.equal((await handleAdminUpdate(f.env, f.groupMessage('one', 1), f.helpers)).blocked, false);
  assert.equal((await handleAdminUpdate(f.env, f.groupMessage('two', 2), f.helpers)).blocked, false);
  assert.deepEqual(await handleAdminUpdate(f.env, f.groupMessage('three', 3), f.helpers),
    {blocked: true, reason: 'flood'});
  assert.equal(f.sent.length, 1);
  f.advance(11);
  assert.equal((await handleAdminUpdate(f.env, f.groupMessage('new window', 4), f.helpers)).blocked, false);
  assert.equal((await handleAdminUpdate(f.env,
    f.groupMessage('other user', 5, {from: {id: 8888}}), f.helpers)).blocked, false);
});

test('non-owner role assignment requires explicit feature and grants scoped permissions', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(await checkAdminRole(f.env, 12345, 'configure', f.helpers), true);
  assert.equal(await checkAdminRole(f.env, 2222, 'read', f.helpers), false);
  assert.match(await f.command('/adminrole', '2222', 'viewer'), /saved/);
  assert.equal(await checkAdminRole(f.env, 2222, 'read', f.helpers), false);
  f.enable('roles');
  assert.equal(await checkAdminRole(f.env, 2222, 'read', f.helpers), true);
  assert.equal(await checkAdminRole(f.env, 2222, 'moderate', f.helpers), false);
  await f.command('/adminrole', '2222', 'moderator');
  assert.equal(await checkAdminRole(f.env, 2222, 'moderate', f.helpers), true);
  assert.equal(await checkAdminRole(f.env, 2222, 'configure', f.helpers), false);
  await f.command('/adminrole', '2222', 'disabled');
  assert.equal(await checkAdminRole(f.env, 2222, 'read', f.helpers), false);
  assert.match(await f.command('/adminrole', '12345', 'viewer'), /Admin:/);
});

test('quota uses atomic daily counters and zero quota blocks', async t => {
  const f = fixture(); t.after(f.close);
  assert.deepEqual(await checkAndConsumeQuota(f.env, 12345, 'download', f.helpers),
    {allowed: true, reason: 'owner'});
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: true, reason: 'disabled'});
  f.enable('roles');
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: false, reason: 'no_quota'});
  assert.match(await f.command('/adminquota', '7777', 'download', '2'), /saved/);
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: true, remaining: 1});
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: true, remaining: 0});
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: false, remaining: 0});
  f.advance(86401);
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: true, remaining: 1});
  await f.command('/adminquota', '8888', 'download', '0');
  assert.deepEqual(await checkAndConsumeQuota(f.env, 8888, 'download', f.helpers),
    {allowed: false, reason: 'zero_quota'});
  await f.command('/adminrole', '7777', 'disabled');
  assert.deepEqual(await checkAndConsumeQuota(f.env, 7777, 'download', f.helpers),
    {allowed: false, reason: 'role_disabled'});
});

test('membership gate is opt-in and fails closed on missing/unavailable membership', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(await checkRequiredMembership(f.env, 7777, f.helpers), true);
  await f.command('/admingate', GROUP, 'on');
  f.enable('member_gate');
  assert.equal(await checkRequiredMembership(f.env, 7777, f.helpers), true);
  assert.deepEqual(f.sent, [{method: 'getChatMember', body: {chat_id: GROUP, user_id: 7777}}]);
  f.helpers.telegram = async () => ({status: 'left'});
  assert.equal(await checkRequiredMembership(f.env, 7777, f.helpers), false);
  f.helpers.telegram = async () => {throw new Error('Not administrator');};
  assert.equal(await checkRequiredMembership(f.env, 7777, f.helpers), false);
  delete f.helpers.telegram;
  assert.equal(await checkRequiredMembership(f.env, 7777, f.helpers), false);
  assert.equal(await checkRequiredMembership(f.env, 12345, f.helpers), true);
});

test('membership requirement caps enabled groups to three', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/admingate', '-1001111111111', 'on'), /ON/);
  assert.match(await f.command('/admingate', '-1002222222222', 'on'), /ON/);
  assert.match(await f.command('/admingate', '-1003333333333', 'on'), /ON/);
  assert.match(await f.command('/admingate', '-1004444444444', 'on'), /At most three/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_required_chats WHERE enabled=1').get().n, 3);
});

test('draft plans and payment interfaces never create a checkout or charge', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/adminplan', 'add', 'personal_plus', '49900', 'INR'), /inactive/);
  assert.match(await f.command('/adminplans'), /personal_plus 49900 INR INACTIVE/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_plans WHERE active=1').get().n, 0);
  assert.match(await f.command('/adminplan', 'add', 'invalid', '-1', 'INR'), /Admin:/);
  const adapter = createPaymentAdapter();
  await assert.rejects(adapter.createCheckout({amount: 10}), /not configured/);
  await assert.rejects(adapter.verifyWebhook('signature'), /not configured/);
  await assert.rejects(adapter.refund('event'), /not configured/);
});

test('rich messages allow plain blocks and inert fixed callback buttons', () => {
  assert.deepEqual(renderRichMessage([
    {type: 'title', text: 'Queue summary'}, {type: 'bullet', text: '<b>No HTML rendering</b>'},
  ], [{text: 'Refresh', callback: 'admin:refresh'}]), {
    text: 'Queue summary\n• <b>No HTML rendering</b>',
    reply_markup: {inline_keyboard: [[{text: 'Refresh', callback_data: 'admin:refresh'}]]},
  });
  assert.throws(() => renderRichMessage([], []), /Empty/);
  assert.throws(() => renderRichMessage([{type: 'html', text: 'oops'}]), /Invalid/);
  assert.throws(() => renderRichMessage([{type: 'title', text: 'Hello'}],
    [{text: 'Run', callback: 'http://evil.example'}]), /Invalid/);
});

test('dashboard is read-only, feature-gated and independently password protected', async t => {
  const f = fixture(); t.after(f.close);
  const page = () => handleAdminHttp(new Request('https://example.org/admin'), f.env, f.helpers);
  const api = token => handleAdminHttp(new Request('https://example.org/admin/api', {
    headers: token ? {authorization: 'Bearer ' + token} : {},
  }), f.env, f.helpers);
  assert.equal((await page()).status, 404);
  f.enable('dashboard');
  assert.equal((await page()).status, 200);
  const html = await (await page()).text();
  assert.match(html, /Read-only/);
  assert.doesNotMatch(html, /super-private-owner-password/);
  assert.equal((await api('bad-token')).status, 403);
  assert.equal((await api('')).status, 403);
  f.env.ORBIT_DASHBOARD_KEY = 'too-short';
  assert.equal((await api('too-short')).status, 503);
  f.env.ORBIT_DASHBOARD_KEY = 'super-private-owner-password-1234567890';
  f.db.prepare('INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)')
    .run(GROUP, 9, OTHER_GROUP, 0, 'all', 'copy');
  f.db.prepare('INSERT INTO archive_items(source,source_message_id,dest,dest_topic,media_kind,filename,saved_at) '
    + 'VALUES(?,?,?,?,?,?,?)').run(GROUP, 1, OTHER_GROUP, 0, 'pdf', '<script>alert(1)</script>', 1_700_000_000);
  f.db.prepare('INSERT INTO jobs(route_id,message_id,state) VALUES(?,?,?)').run(1, 4, 'queued');
  f.db.prepare('INSERT INTO manual_jobs(source,dest,message_id) VALUES(?,?,?)').run(GROUP, OTHER_GROUP, 7);
  f.db.prepare('INSERT INTO topics(chat,thread,title) VALUES(?,?,?)').run(GROUP, 9, 'Documents');
  const response = await api(f.env.ORBIT_DASHBOARD_KEY);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.equal(data.stats.routes, 1);
  assert.equal(data.stats.saved_items, 1);
  assert.equal(data.stats.manual_jobs, 1);
  assert.equal(data.stats.known_topics, 1);
  assert.equal(data.routes[0].topic, 9);
  assert.equal(data.archive[0].filename, '<script>alert(1)</script>');
  assert.deepEqual(data.queues.map(row => row.kind), ['relay', 'manual']);
  assert.equal(data.topics[0].title, 'Documents');
  const js = await handleAdminHttp(new Request('https://example.org/admin/app.js'), f.env, f.helpers);
  assert.match(await js.text(), /td\.textContent/);
  assert.doesNotThrow(() => new Function(DASHBOARD_SCRIPT));
  assert.equal((await handleAdminHttp(new Request('https://example.org/not-admin'), f.env, f.helpers)), null);
  assert.equal((await handleAdminHttp(new Request('https://example.org/admin', {method: 'POST'}),
    f.env, f.helpers)).status, 405);
});

test('scheduler cleans only old metadata and runs at most once per day', async t => {
  const f = fixture(); t.after(f.close);
  f.db.prepare('INSERT INTO admin_moderation_seen(chat,message_id,handled_at,blocked) VALUES(?,?,?,?)')
    .run(GROUP, 1, 1_600_000_000, 1);
  f.db.prepare('INSERT INTO admin_audit(at,action,detail) VALUES(?,?,?)')
    .run(1_600_000_000, 'old', 'old metadata');
  await runAdminScheduled(f.env, f.helpers);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_moderation_seen').get().n, 0);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_audit').get().n, 0);
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('admin_last_cleanup').value,
    '1700000000');
  f.db.prepare('INSERT INTO admin_audit(at,action,detail) VALUES(?,?,?)')
    .run(1_600_000_000, 'still_old', 'will wait');
  await runAdminScheduled(f.env, f.helpers);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_audit').get().n, 1);
  f.advance(86401);
  await runAdminScheduled(f.env, f.helpers);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM admin_audit').get().n, 0);
});
