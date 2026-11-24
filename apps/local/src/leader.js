/** Optional Redis lease. Redis coordinates instances; SQLite remains the job queue. */
import {createHash, randomUUID} from 'node:crypto';

const RELEASE = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const RENEW = "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE',KEYS[1],ARGV[2]) else return 0 end";

export function leaseKey(token) {
  return 'orbitsuite:leader:' + createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export function redisLease(client, token, {ttlMs = 90000, clock = () => Date.now()} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 30000) throw new Error('Redis lease must last 30 seconds or longer');
  const key = leaseKey(token);
  const holder = randomUUID();
  let ownedUntil = 0;
  let closed = false;
  return {
    isLeader() {return !closed && ownedUntil > clock();},
    async refresh() {
      if (closed) return false;
      try {
        if (ownedUntil > clock()) {
          const renewed = await client.eval(RENEW, {keys: [key], arguments: [holder, String(ttlMs)]});
          ownedUntil = Number(renewed) === 1 ? clock() + ttlMs : 0;
        } else {
          const acquired = await client.set(key, holder, {NX: true, PX: ttlMs});
          ownedUntil = acquired === 'OK' ? clock() + ttlMs : 0;
        }
      } catch (error) {
        ownedUntil = 0;
        throw error;
      }
      return this.isLeader();
    },
    async close() {
      closed = true;
      ownedUntil = 0;
      try {await client.eval(RELEASE, {keys: [key], arguments: [holder]});}
      finally {await client.quit();}
    },
  };
}

export async function openLeader(config = process.env, options = {}) {
  if (!config.REDIS_URL) return {isLeader: () => true, refresh: async () => true, close: async () => {}};
  const redis = options.redis || await import('redis');
  const client = options.client || redis.createClient({url: config.REDIS_URL});
  client.on?.('error', () => {}); // refresh() logs failure; no secrets in diagnostics.
  if (!options.client) await client.connect();
  const lease = redisLease(client, config.BOT_TOKEN, {ttlMs: 90000});
  try {await lease.refresh();}
  catch (error) {await client.quit(); throw error;}
  return lease;
}
