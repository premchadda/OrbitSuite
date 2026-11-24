import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {handleMiniHttp, miniAppUrl, verifyMiniInitData} from '../src/mini_app.js';

const TOKEN = '12345:private_test_bot_token';
const OWNER = '987654321';
const NOW = 1764000000;
function signedInit(userId = OWNER, timestamp = NOW, extras = {}) {
  const values = {auth_date: String(timestamp), query_id: 'AA12345',
    user: JSON.stringify({id: Number(userId), first_name: 'Private'}), ...extras};
  const check = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({...values, hash}).toString();
}

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => /^\d+.*\.sql$/.test(f)).sort()) {
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const env = {DB: {prepare: sql => ({bind: (...args) => ({
    first: async () => db.prepare(sql).get(...args),
    all: async () => ({results: db.prepare(sql).all(...args)}),
    run: async () => ({meta: {changes: db.prepare(sql).run(...args).changes}}),
  })})}, BOT_TOKEN: TOKEN, OWNER_ID: OWNER};
  return {db, env, close: () => db.close()};
}

test('Telegram initData signature is validated with owner, timestamp and unique fields', async () => {
  assert.equal(await verifyMiniInitData(signedInit(), TOKEN, OWNER, NOW), true);
  assert.equal(await verifyMiniInitData(signedInit('12345'), TOKEN, OWNER, NOW), false);
  assert.equal(await verifyMiniInitData(signedInit(OWNER, NOW - 601), TOKEN, OWNER, NOW), false);
  assert.equal(await verifyMiniInitData(signedInit(OWNER, NOW + 31), TOKEN, OWNER, NOW), false);
  assert.equal(await verifyMiniInitData(signedInit().replace('Private', 'Intruder'), TOKEN, OWNER, NOW), false);
  assert.equal(await verifyMiniInitData(signedInit() + '&auth_date=1764000000', TOKEN, OWNER, NOW), false);
  assert.equal(await verifyMiniInitData('garbage', TOKEN, OWNER, NOW), false);
  assert.equal(await verifyMiniInitData('x'.repeat(4097), TOKEN, OWNER, NOW), false);
});

test('Mini App URL rejects non-HTTPS, credentials and arbitrary paths', () => {
  assert.equal(miniAppUrl('https://private.example'), 'https://private.example/mini');
  for (const bad of ['http://private.example', 'https://user:pass@private.example',
                     'https://private.example/other', 'https://private.example/#a',
                     'https://private.example/?q=1']) {
    assert.equal(miniAppUrl(bad), null);
  }
});

test('Mini App shell is public but signed owner data requires enabled dashboard', async t => {
  const f = fixture(); t.after(f.close);
  const url = 'https://example.com/mini/api';
  const request = (init) => new Request(url, {method: 'POST',
    headers: init ? {authorization: 'tma ' + init} : {}});
  assert.equal((await handleMiniHttp(request(signedInit()), f.env, {now: () => NOW})).status, 404);
  f.db.exec("UPDATE admin_feature_flags SET enabled=1 WHERE name='dashboard'");
  const html = await handleMiniHttp(new Request('https://example.com/mini'), f.env);
  assert.equal(html.status, 200);
  assert.match(await html.text(), /telegram-web-app\.js/);
  assert.equal((await handleMiniHttp(request(), f.env, {now: () => NOW})).status, 403);
  assert.equal((await handleMiniHttp(request(signedInit('33')), f.env, {now: () => NOW})).status, 403);
  const valid = await handleMiniHttp(request(signedInit()), f.env, {now: () => NOW});
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('cache-control'), 'no-store');
  const snapshot = await valid.json();
  assert.equal(snapshot.stats.routes, 0);
  assert.ok(Array.isArray(snapshot.topics));
  const script = await handleMiniHttp(new Request('https://example.com/mini/app.js'), f.env);
  assert.match(await script.text(), /textContent/);
  assert.equal((await handleMiniHttp(new Request('https://example.com/mini/api'), f.env)).status, 405);
});
