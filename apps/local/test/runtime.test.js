import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.js';
import {pollOnce, makeServer, runLocal} from '../src/runtime.js';
import {isDirectEntrypoint} from '../src/entrypoint.js';

test('CLI detection handles Windows drive letters, casing, and spaces', () => {
  const url = 'file:///C:/Users/Test%20User/OrbitSuite/apps/local/src/runtime.js';
  assert.equal(isDirectEntrypoint(url,
    'c:\\Users\\Test User\\OrbitSuite\\apps\\local\\src\\RUNTIME.js', 'win32'), true);
  assert.equal(isDirectEntrypoint(url, 'C:\\other\\runtime.js', 'win32'), false);
  assert.equal(isDirectEntrypoint('file:///tmp/OrbitSuite/runtime.js',
    '/tmp/OrbitSuite/runtime.js', 'linux'), true);
  assert.equal(isDirectEntrypoint(url, undefined, 'win32'), false);
});

test('local runtime forwards only explicitly supported optional feature variables', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'orbit-feature-env-'));
  try {
    const config = {
      BOT_TOKEN: 'TEST', OWNER_ID: '123', WEBHOOK_SECRET: 'LONG_PRIVATE_SECRET',
      ORBIT_MODE: 'webhook', ORBIT_PORT: '0',
      ORBIT_DB_PATH: join(folder, 'test.sqlite'),
      ORBIT_PUBLIC_URL: 'https://test.example',
      ORBIT_DASHBOARD_KEY: 'a-private-different-key-for-dashboard',
      ORBIT_AI_MODEL: 'local-model', ORBIT_RSS_HOSTS: 'feeds.example.org',
      UNRELATED_HOST_SECRET: 'must-never-enter-bot-env',
    };
    const runtime = await runLocal(config);
    try {
      assert.equal(runtime.env.ORBIT_PUBLIC_URL, config.ORBIT_PUBLIC_URL);
      assert.equal(runtime.env.ORBIT_DASHBOARD_KEY, config.ORBIT_DASHBOARD_KEY);
      assert.equal(runtime.env.ORBIT_AI_MODEL, config.ORBIT_AI_MODEL);
      assert.equal(runtime.env.ORBIT_RSS_HOSTS, config.ORBIT_RSS_HOSTS);
      assert.equal(runtime.env.UNRELATED_HOST_SECRET, undefined);
    } finally {await runtime.close();}
  } finally {rmSync(folder, {recursive: true, force: true});}
});

const migrationCount = readdirSync(new URL('../../worker/migrations/', import.meta.url))
  .filter(name => /^\d+.*\.sql$/.test(name)).length;

test('local SQLite migration applies once and persists settings on reopen', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'orbit-local-test-'));
  t.after(() => rmSync(folder, {recursive: true}));
  const filename = join(folder, 'config.db');
  const first = openStore(filename);
  await first.prepare('INSERT INTO settings(key,value) VALUES(?,?)').bind('test', 'value').run();
  assert.equal(first._raw.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, migrationCount);
  first.close();
  const second = openStore(filename);
  assert.equal((await second.prepare('SELECT value FROM settings WHERE key=?').bind('test').first()).value, 'value');
  assert.equal(second._raw.prepare('SELECT count(*) AS n FROM schema_migrations').get().n, migrationCount);
  second.close();
});

test('D1-shaped batch is atomic and rolls back invalid inserts', async t => {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  await assert.rejects(() => DB.batch([
    DB.prepare('INSERT INTO notes(body) VALUES(?)').bind('first'),
    DB.prepare('INSERT INTO notes(nonexistent) VALUES(?)').bind('bad'),
  ]));
  assert.equal(DB._raw.prepare('SELECT count(*) AS n FROM notes').get().n, 0);
});

test('polling consumes updates with persistent offsets and no external webhook', async t => {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  const env = {DB, BOT_TOKEN: 'TEST', OWNER_ID: '123', WEBHOOK_SECRET: 'LOCAL_WEBHOOK_SECRET'};
  const offsets = [];
  const request = async (_token, method, body) => {
    assert.equal(method, 'getUpdates');
    assert.ok(body.allowed_updates.includes('edited_message'));
    assert.ok(body.allowed_updates.includes('edited_channel_post'));
    assert.ok(body.allowed_updates.includes('callback_query'));
    offsets.push(body.offset);
    if (body.offset) return [];
    return [{update_id: 17, message: {chat: {type: 'private', id: 55}, from: {id: 999}, text: '/stop'}}];
  };
  assert.equal(await pollOnce(env, request), 1);
  await pollOnce(env, request);
  assert.deepEqual(offsets, [0, 18]);
  assert.equal((await DB.prepare('SELECT value FROM settings WHERE key=?').bind('telegram_poll_offset').first()).value, '18');
});

test('HTTP wrapper preserves webhook authentication and supports health probes', async t => {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  const env = {DB, BOT_TOKEN: 'TEST', OWNER_ID: '123', WEBHOOK_SECRET: 'LOCAL_WEBHOOK_SECRET'};
  const server = makeServer(env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const probe = await fetch(url + '/healthz');
  assert.deepEqual(await probe.json(), {ok: true, service: 'orbitsuite'});
  const readiness = await fetch(url + '/readyz');
  assert.deepEqual(await readiness.json(), {ok: true, leader: true});
  const rejected = await fetch(url + '/telegram', {method: 'POST', body: '{}'});
  assert.equal(rejected.status, 403);
});

test('runtime requires explicit PostgreSQL connection and rejects unknown storage', async () => {
  const config = {
    BOT_TOKEN: 'TEST', OWNER_ID: '123', WEBHOOK_SECRET: 'LONG_PRIVATE_SECRET',
    ORBIT_MODE: 'webhook', ORBIT_PORT: '0',
  };
  await assert.rejects(runLocal({...config, ORBIT_STORE: 'not-real'}), /ORBIT_STORE/);
  await assert.rejects(runLocal({...config, ORBIT_STORE: 'postgres'}), /DATABASE_URL or PGHOST/);
});

test('local media heartbeat authenticates private worker and extends active claim only', async t => {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  await DB.prepare("INSERT INTO media_jobs(url,kind,dest,state,claimed_at,created_at) VALUES('https://example.com','video','2','running',100,100)").bind().run();
  const env = {DB, BOT_TOKEN: 'TEST', OWNER_ID: '123', WEBHOOK_SECRET: 'LOCAL_WEBHOOK_SECRET', MEDIA_WORKER_KEY: 'a-private-media-key'};
  const server = makeServer(env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/internal/media/heartbeat';
  assert.equal((await fetch(url, {method: 'POST', body: JSON.stringify({id: 1})})).status, 403);
  const response = await fetch(url, {
    method: 'POST', headers: {'content-type': 'application/json', 'X-Orbit-Service-Key': env.MEDIA_WORKER_KEY},
    body: JSON.stringify({id: 1}),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const row = await DB.prepare('SELECT claimed_at FROM media_jobs WHERE id=1').bind().first();
  assert.ok(row.claimed_at > 100);
  assert.equal((await fetch(url, {
    method: 'POST', headers: {'X-Orbit-Service-Key': env.MEDIA_WORKER_KEY}, body: JSON.stringify({id: 999}),
  })).status, 409);
});
