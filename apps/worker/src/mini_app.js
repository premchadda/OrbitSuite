/** Telegram-signed owner-only Mini App, read-only and disabled by default.
 * Specification: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
import {adminSnapshot} from './admin_extensions.js';
import {MINI_HTML, MINI_SCRIPT} from '../../dashboard/mini.js';

const MAX_INIT_DATA = 4096;
const MAX_AGE_SECONDS = 600;
const utf8 = text => new TextEncoder().encode(text);

function equalDigest(computed, provided) {
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false;
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= computed[i] ^ Number.parseInt(provided.slice(i * 2, i * 2 + 2), 16);
  return diff === 0;
}

export function miniAppUrl(input) {
  let target;
  try { target = new URL(String(input || '')); } catch { return null; }
  if (target.protocol !== 'https:' || !target.hostname || target.username || target.password
    || target.port || !['', '/'].includes(target.pathname) || target.search || target.hash
    || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(target.hostname)
    || target.hostname.endsWith('.local') || target.hostname.endsWith('.internal')) return null;
  return target.origin + '/mini';
}

export async function verifyMiniInitData(initData, token, ownerId, now = Math.floor(Date.now() / 1000)) {
  if (typeof initData !== 'string' || !initData || initData.length > MAX_INIT_DATA
      || typeof token !== 'string' || token.length < 8 || !/^\d+$/.test(String(ownerId || ''))) return false;
  const params = new URLSearchParams(initData);
  const seen = new Set();
  for (const [key, value] of params) {
    if (!key || seen.has(key) || key.length > 64 || value.length > 3000) return false;
    seen.add(key);
  }
  const seconds = Number(params.get('auth_date'));
  if (!/^\d{9,12}$/.test(params.get('auth_date') || '') || !Number.isSafeInteger(seconds)
      || seconds > now + 30 || now - seconds > MAX_AGE_SECONDS) return false;
  let user;
  try { user = JSON.parse(params.get('user') || ''); } catch { return false; }
  if (!user || String(user.id) !== String(ownerId) || user.is_bot === true) return false;
  const hash = params.get('hash') || '';
  const checkString = [...params.entries()]
    .filter(([key]) => key !== 'hash' && key !== 'signature')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, value]) => key + '=' + value).join('\n');
  const sourceKey = await crypto.subtle.importKey('raw', utf8('WebAppData'),
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', sourceKey, utf8(token));
  const secretKey = await crypto.subtle.importKey('raw', secret,
    {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', secretKey, utf8(checkString)));
  return equalDigest(digest, hash);
}

const security = {
  'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self' https://telegram.org; "
    + "connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; "
    + 'frame-ancestors https://web.telegram.org https://*.telegram.org',
};

export async function handleMiniHttp(request, env, helpers = {}) {
  const path = new URL(request.url).pathname;
  if (!['/mini', '/mini/', '/mini/app.js', '/mini/api'].includes(path)) return null;
  const settings = await (helpers.query
    ? helpers.query('SELECT enabled FROM admin_feature_flags WHERE name=?', 'dashboard')
    : env.DB.prepare('SELECT enabled FROM admin_feature_flags WHERE name=?').bind('dashboard')).first();
  if (!settings?.enabled) return new Response('Not found', {status: 404, headers: security});
  if (path === '/mini/api') {
    if (request.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: security});
    const authorization = request.headers.get('authorization') || '';
    if (!authorization.startsWith('tma ') || !(await verifyMiniInitData(
      authorization.slice(4), env.BOT_TOKEN, env.OWNER_ID,
      Number(helpers.now?.() || Math.floor(Date.now() / 1000))))) {
      return new Response('Forbidden', {status: 403, headers: security});
    }
    try { return Response.json(await adminSnapshot(env, helpers), {headers: security}); }
    catch { return new Response('Snapshot unavailable', {status: 503, headers: security}); }
  }
  if (request.method !== 'GET') return new Response('Method not allowed', {status: 405, headers: security});
  return new Response(path === '/mini/app.js' ? MINI_SCRIPT : MINI_HTML,
    {headers: {...security, 'Content-Type': path === '/mini/app.js'
      ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8'}});
}
