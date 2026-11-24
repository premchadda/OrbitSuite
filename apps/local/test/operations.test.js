import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../src/store.js';
import {backupSqlite, restoreSqlite} from '../src/backup.js';
import {redisLease, leaseKey} from '../src/leader.js';
import {createAlerter, ensureOpsTables, reconcileStale, healthSnapshot} from '../src/maintenance.js';

test('Redis lease is scoped to one token, cannot release another holder, and stops when lost', async () => {
  const data = new Map();
  let clock = 10000;
  const client = {
    async set(key, token, options) {
      if (options.NX && data.has(key)) return null;
      data.set(key, token); return 'OK';
    },
    async eval(script, {keys, arguments: args}) {
      if (data.get(keys[0]) !== args[0]) return 0;
      if (script.includes("'DEL'")) data.delete(keys[0]);
      return 1;
    },
    async quit() {},
  };
  assert.notEqual(leaseKey('bot:one'), leaseKey('bot:two'));
  const first = redisLease(client, 'bot:one', {clock: () => clock});
  const second = redisLease(client, 'bot:one', {clock: () => clock});
  assert.equal(await first.refresh(), true);
  assert.equal(await second.refresh(), false);
  assert.equal(await first.refresh(), true);
  await first.close();
  assert.equal(await second.refresh(), true);
  clock += 91000;
  assert.equal(second.isLeader(), false);
  await second.close();
});

test('stale claims enter a manual-review dead letter ledger without retrying sends', async t => {
  const DB = openStore(':memory:');
  t.after(() => DB.close());
  await DB.prepare('INSERT INTO routes(source,dest) VALUES(?,?)').bind('1', '2').run();
  await DB.prepare("INSERT INTO jobs(route_id,message_id,state,claimed_at) VALUES(1,10,'sending',100)").bind().run();
  await DB.prepare("INSERT INTO manual_jobs(source,dest,message_id,state,claimed_at) VALUES('1','2',11,'sending',100)").bind().run();
  await DB.prepare("INSERT INTO media_jobs(url,kind,dest,state,claimed_at,created_at) VALUES('https://example.com','video','2','running',100,100)").bind().run();
  await ensureOpsTables(DB);
  const stale = await reconcileStale(DB, {now: 1000, staleSeconds: 300, mediaStaleSeconds: 300});
  assert.deepEqual(stale.map(x => x.kind).sort(), ['jobs', 'manual_jobs', 'media_jobs']);
  assert.deepEqual(await reconcileStale(DB, {now: 1000, staleSeconds: 300, mediaStaleSeconds: 300}), []);
  const count = await DB.prepare('SELECT count(*) AS n FROM ops_dead_letters').bind().first();
  assert.equal(count.n, 3);
  const job = await DB.prepare('SELECT state FROM jobs WHERE id=1').bind().first();
  assert.equal(job.state, 'uncertain');
  assert.deepEqual((await healthSnapshot(DB)).leader, true);
});

test('owner alerts are opt-in, redacted, and cooldown-limited', async () => {
  const requests = [];
  let clock = 100;
  const config = {ORBIT_ALERTS: '1', ORBIT_ALERT_COOLDOWN_SECONDS: '60', BOT_TOKEN: 'opaque', OWNER_ID: '123'};
  const alert = createAlerter(config, async (url, init) => {
    requests.push({url, body: JSON.parse(init.body)});
    return {ok: true};
  }, () => clock);
  assert.equal(await alert('three stale jobs'), true);
  assert.equal(await alert('ignored'), false);
  clock += 61000;
  assert.equal(await alert('second alert'), true);
  assert.deepEqual(requests.map(x => x.body.text), ['OrbitSuite alert: three stale jobs', 'OrbitSuite alert: second alert']);
  assert.equal(await createAlerter({...config, ORBIT_ALERTS: '0'})('disabled'), false);
});

test('SQLite backup can restore to absent path, refuses destructive overwrite', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'orbit-backup-test-'));
  t.after(() => rmSync(folder, {recursive: true}));
  const live = join(folder, 'live.sqlite');
  const snapshot = join(folder, 'backup.sqlite');
  const restored = join(folder, 'restored.sqlite');
  const DB = openStore(live);
  await DB.prepare('INSERT INTO notes(body) VALUES(?)').bind('durable').run();
  await backupSqlite(live, snapshot);
  assert.equal(existsSync(snapshot), true);
  await assert.rejects(backupSqlite(live, snapshot), /exists/);
  DB.close();
  await restoreSqlite(snapshot, restored);
  const reopened = openStore(restored);
  assert.equal(reopened._raw.prepare('SELECT body FROM notes').get().body, 'durable');
  reopened.close();
  await assert.rejects(restoreSqlite(snapshot, restored), /must not exist/);
});
