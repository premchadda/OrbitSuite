/** Conservative crash reconciliation and redacted operator alerts. */

const TABLES = Object.freeze([
  ['jobs', 'sending'],
  ['manual_jobs', 'sending'],
  ['media_jobs', 'running'],
  ['album_batches', 'sending'],
]);

export async function ensureOpsTables(DB) {
  await DB.prepare('CREATE TABLE IF NOT EXISTS ops_dead_letters(' +
    'kind TEXT NOT NULL, job_id BIGINT NOT NULL, reason TEXT NOT NULL, recorded_at BIGINT NOT NULL,' +
    'PRIMARY KEY(kind,job_id))').bind().run();
}

/** Never retry possibly delivered Telegram messages; mark as uncertain for review. */
export async function reconcileStale(DB, {now = Math.floor(Date.now() / 1000), staleSeconds = 600,
  mediaStaleSeconds = 21600} = {}) {
  if (!Number.isSafeInteger(staleSeconds) || staleSeconds < 300) throw new Error('Staleness threshold must be >= 300 seconds');
  if (!Number.isSafeInteger(mediaStaleSeconds) || mediaStaleSeconds < 300) throw new Error('Media staleness threshold must be >= 300 seconds');
  await ensureOpsTables(DB);
  const stale = [];
  for (const [table, from] of TABLES) {
    const limit = now - (table === 'media_jobs' ? mediaStaleSeconds : staleSeconds);
    const list = (await DB.prepare('SELECT id FROM ' + table +
      ' WHERE state=? AND claimed_at IS NOT NULL AND claimed_at<? LIMIT 100')
      .bind(from, limit).all()).results;
    for (const job of list) {
      const changed = await DB.prepare('UPDATE ' + table +
        " SET state='uncertain', error='stale worker; inspect Telegram destination'" +
        ' WHERE id=? AND state=? AND claimed_at<?').bind(job.id, from, limit).run();
      if (!changed.meta.changes) continue;
      await DB.prepare('INSERT INTO ops_dead_letters(kind,job_id,reason,recorded_at) VALUES(?,?,?,?) ' +
        'ON CONFLICT(kind,job_id) DO NOTHING')
        .bind(table, job.id, 'stale_' + from, now).run();
      stale.push({kind: table, id: job.id});
    }
  }
  return stale;
}

export async function healthSnapshot(DB, leader = {isLeader: () => true}) {
  const check = await DB.prepare('SELECT 1 AS healthy').bind().first();
  if (Number(check?.healthy) !== 1) throw new Error('Database probe failed');
  const queues = {};
  for (const [table] of TABLES) {
    const row = await DB.prepare("SELECT count(*) AS n FROM " + table + " WHERE state IN ('queued','sending','running','uncertain')").bind().first();
    queues[table] = Number(row?.n || 0);
  }
  return {ok: true, leader: leader.isLeader(), queues};
}

/** Owner-only Telegram alert. The message contains counts, never tokens or media. */
export function createAlerter(config, transport = fetch, clock = () => Date.now()) {
  let last = -Infinity;
  const enabled = config.ORBIT_ALERTS === '1';
  const cooldown = Math.max(60000, Number(config.ORBIT_ALERT_COOLDOWN_SECONDS || 3600) * 1000);
  return async message => {
    if (!enabled || clock() - last < cooldown) return false;
    last = clock();
    const response = await transport('https://api.telegram.org/bot' + config.BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: {'content-type': 'application/json'},
      body: JSON.stringify({chat_id: config.OWNER_ID, text: 'OrbitSuite alert: ' + String(message).slice(0, 200)}),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error('Owner alert delivery failed');
    return true;
  };
}
