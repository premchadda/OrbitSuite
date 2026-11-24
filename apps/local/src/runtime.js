/** Standalone, dependency-free runtime for the shared OrbitSuite bot core. */
import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {openStore} from './store.js';
import {openPostgresStore} from './postgres.js';
import {openLeader} from './leader.js';
import {createAlerter, ensureOpsTables, healthSnapshot, reconcileStale} from './maintenance.js';
import {isDirectEntrypoint} from './entrypoint.js';
import worker from '../../worker/src/index.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const API = 'https://api.telegram.org/bot';

async function telegramControl(token, method, data = {}, timeout = 35000) {
  const response = await fetch(API + token + '/' + method, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(timeout),
  });
  const json = await response.json();
  if (!response.ok || !json.ok) throw new Error('Telegram control API ' + method + ' failed');
  return json.result;
}

export async function deliverUpdate(update, env) {
  const response = await worker.fetch(new Request('http://internal.local/telegram', {
    method: 'POST',
    headers: {'content-type': 'application/json',
      'X-Telegram-Bot-Api-Secret-Token': env.WEBHOOK_SECRET},
    body: JSON.stringify(update),
  }), env);
  if (!response.ok) throw new Error('Bot rejected an incoming update (' + response.status + ')');
}

export async function pollOnce(env, request = telegramControl) {
  const get = key => env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  const set = (key, value) => env.DB.prepare(
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).bind(key, String(value)).run();
  let offset = Number((await get('telegram_poll_offset'))?.value || 0);
  const updates = await request(env.BOT_TOKEN, 'getUpdates', {
    offset, limit: 10, timeout: 20,
    allowed_updates: ['message', 'channel_post', 'edited_message', 'edited_channel_post', 'callback_query'],
  });
  if (!Array.isArray(updates)) throw new Error('Invalid getUpdates response');
  for (const update of updates) {
    if (!Number.isSafeInteger(update.update_id)) continue;
    if (update.update_id < offset) continue;
    await deliverUpdate(update, env);
    offset = update.update_id + 1;
    await set('telegram_poll_offset', offset);
  }
  return updates.length;
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const buffers = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body too large');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers);
}

export function makeServer(env, {leader} = {}) {
  return createServer(async (req, res) => {
    try {
      if (req.url?.split('?')[0] === '/internal/media/heartbeat') {
        const expected = Buffer.from(env.MEDIA_WORKER_KEY || '');
        const keyHeader = req.headers['x-orbit-service-key'];
        const received = Buffer.from(typeof keyHeader === 'string' ? keyHeader : '');
        if (req.method !== 'POST' || !expected.length || received.length !== expected.length ||
          !timingSafeEqual(expected, received)) {
          res.writeHead(403); res.end('Forbidden'); return;
        }
        let data;
        try {data = JSON.parse((await readBody(req, 8192)).toString());}
        catch {res.writeHead(400); res.end('Invalid JSON'); return;}
        if (!Number.isSafeInteger(data?.id) || data.id <= 0) {
          res.writeHead(400); res.end('Invalid job'); return;
        }
        const result = await env.DB.prepare("UPDATE media_jobs SET claimed_at=? WHERE id=? AND state='running'")
          .bind(Math.floor(Date.now() / 1000), data.id).run();
        res.writeHead(result.meta.changes ? 200 : 409, {'content-type': 'application/json'});
        res.end(JSON.stringify({ok: Boolean(result.meta.changes)}));
        return;
      }
      if (req.url?.split('?')[0] === '/readyz' && ['HEAD', 'GET'].includes(req.method)) {
        try {
          const snapshot = await healthSnapshot(env.DB, leader);
          res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ok: snapshot.ok, leader: snapshot.leader}));
        } catch {
          res.writeHead(503, {'content-type': 'application/json', 'cache-control': 'no-store'});
          res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ok: false}));
        }
        return;
      }
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req);
      const request = new Request('http://localhost' + (req.url || '/'), {
        method: req.method,
        headers: req.headers,
        ...(body ? {body} : {}),
      });
      const response = await worker.fetch(request, env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      res.writeHead(error.message === 'Request body too large' ? 413 : 500);
      res.end('Request rejected');
    }
  });
}

export async function runLocal(config = process.env) {
  const mode = (config.ORBIT_MODE || 'polling').toLowerCase();
  if (!['polling', 'webhook'].includes(mode)) throw new Error('ORBIT_MODE must be polling or webhook');
  const {BOT_TOKEN, OWNER_ID, WEBHOOK_SECRET} = config;
  if (!BOT_TOKEN || !/^\d+$/.test(OWNER_ID || '') || !WEBHOOK_SECRET || WEBHOOK_SECRET.length < 16) {
    throw new Error('BOT_TOKEN, numeric OWNER_ID, and WEBHOOK_SECRET (16+ chars) are required');
  }
  const store = (config.ORBIT_STORE || 'sqlite').toLowerCase();
  if (!['sqlite', 'postgres'].includes(store)) throw new Error('ORBIT_STORE must be sqlite or postgres');
  if (store === 'postgres' && !config.DATABASE_URL && !config.PGHOST) {
    throw new Error('DATABASE_URL or PGHOST is required for PostgreSQL');
  }
  const DB = store === 'postgres'
    ? await openPostgresStore(config)
    : openStore(config.ORBIT_DB_PATH || 'data/orbitsuite.sqlite');
  let leader;
  try {
    await ensureOpsTables(DB);
    leader = await openLeader(config);
  } catch (error) {await DB.close(); throw error;}
  // Pass only documented bot feature settings; do not copy unrelated host env.
  const featureKeys = [
    'ORBIT_AI_BASE_URL', 'ORBIT_AI_KEY', 'ORBIT_AI_MODEL', 'ORBIT_DASHBOARD_KEY',
    'ORBIT_PUBLIC_URL', 'ORBIT_RSS_ALLOW_LOCAL_HTTP', 'ORBIT_RSS_HOSTS',
    'ORBIT_RSS_PARSER_TOKEN', 'ORBIT_RSS_PARSER_URL',
  ];
  const featureConfig = Object.fromEntries(featureKeys.filter(key => config[key] !== undefined)
    .map(key => [key, config[key]]));
  const env = {...featureConfig, DB, BOT_TOKEN, OWNER_ID, WEBHOOK_SECRET,
    MEDIA_WORKER_KEY: config.MEDIA_WORKER_KEY || ''};
  const server = makeServer(env, {leader});
  const alert = createAlerter(config);
  const warn = async message => {
    process.stderr.write('OrbitSuite: ' + message + '\n');
    try {await alert(message);} catch {process.stderr.write('OrbitSuite owner alert failed\n');}
  };
  const port = Number(config.ORBIT_PORT || 8787);
  const host = config.ORBIT_HOST || '127.0.0.1';
  const tickSeconds = Math.max(1, Math.min(60, Number(config.ORBIT_TICK_SECONDS || 5)));
  let active = true;
  let tickerBusy = false;
  let pollTask;
  let lastReconcile = 0;

  try {
    if (mode === 'polling') {
      const info = await telegramControl(BOT_TOKEN, 'getWebhookInfo');
      if (info?.url) throw new Error('A Telegram webhook is still active; remove it explicitly before using polling');
    }
    await new Promise((resolve, reject) => server.listen(port, host, resolve).once('error', reject));
  } catch (error) {
    await leader.close();
    await DB.close();
    throw error;
  }

  const tick = async () => {
    if (tickerBusy || !active || !leader.isLeader()) return;
    tickerBusy = true;
    try {
      await worker.scheduled({}, env);
      if (Date.now() - lastReconcile >= 60000) {
        lastReconcile = Date.now();
        const stale = await reconcileStale(DB, {
          staleSeconds: Math.max(300, Number(config.ORBIT_STALE_SECONDS || 600)),
          mediaStaleSeconds: Math.max(300, Number(config.ORBIT_MEDIA_STALE_SECONDS || 21600)),
        });
        if (stale.length) await warn(stale.length + ' stale jobs require manual review');
      }
    } catch { await warn('Background health tick failed; inspect local logs'); }
    finally { tickerBusy = false; }
  };
  const interval = setInterval(tick, tickSeconds * 1000);
  const leaseInterval = setInterval(() => {
    void leader.refresh().catch(() => warn('Redis lease unavailable; work paused'));
  }, 25000);
  void tick();
  if (mode === 'polling') {
    pollTask = (async () => {
      while (active) {
        if (!leader.isLeader()) {await sleep(2000); continue;}
        try { await pollOnce(env); }
        catch { await warn('Polling unavailable; retrying later'); await sleep(5000); }
      }
    })();
  }
  const close = async () => {
    if (!active) return;
    active = false;
    clearInterval(interval);
    clearInterval(leaseInterval);
    await new Promise(resolve => server.close(resolve));
    // The in-flight getUpdates call may remain open up to 35 seconds.
    if (pollTask) await pollTask;
    await leader.close();
    await DB.close();
  };
  return {server, env, close};
}

if (isDirectEntrypoint(import.meta.url)) {
  runLocal().then(runtime => {
    process.stdout.write('OrbitSuite local runtime ready (polling or webhook).\n');
    process.on('SIGTERM', () => { void runtime.close(); });
    process.on('SIGINT', () => { void runtime.close(); });
  }).catch(error => {
    process.stderr.write('OrbitSuite startup failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
