/** Optional administration modules. No account sessions or payment credentials. */
import {parseTelegramUserId, validChat, validPositiveId} from './core.js';
import {DASHBOARD_HTML, DASHBOARD_SCRIPT} from '../../dashboard/ui.js';

const FEATURES = new Set(['moderation', 'antiflood', 'member_gate', 'roles', 'plans', 'dashboard']);
const QUOTA_ACTIONS = new Set(['archive', 'download', 'broadcast', 'api']);
const ROLES = new Set(['moderator', 'viewer', 'disabled']);
const VALID_KINDS = new Set(['title', 'paragraph', 'bullet', 'code']);
const MAX_TERMS = 30;
const MAX_TEXT = 3800;
const q = (env, helpers, sql, ...args) => helpers?.query
  ? helpers.query(sql, ...args) : env.DB.prepare(sql).bind(...args);
const now = helpers => Number(helpers?.now?.() || Math.floor(Date.now() / 1000));
const safeInt = (value, minimum = 0, maximum = 2147483647) => {
  const str = String(value ?? '');
  const parsed = Number(str);
  return /^\d+$/.test(str) && Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed : null;
};
const feature = async (env, helpers, name) => Boolean((await q(env, helpers,
  'SELECT enabled FROM admin_feature_flags WHERE name=?', name).first())?.enabled);
const rows = async (env, helpers, sql, ...args) =>
  (await q(env, helpers, sql, ...args).all()).results || [];
const audit = async (env, helpers, action, detail = '') =>
  q(env, helpers, 'INSERT INTO admin_audit(at,action,detail) VALUES(?,?,?)',
    now(helpers), action, String(detail).slice(0, 100)).run();

/**
 * Safe Telegram presentation: plain text and fixed callback buttons only.
 * Callbacks are application-defined; this function never executes commands.
 */
export function renderRichMessage(blocks, buttons = []) {
  if (!Array.isArray(blocks) || !Array.isArray(buttons) || blocks.length > 35 || buttons.length > 12) {
    throw new ValueError('Too many message blocks or buttons');
  }
  const parts = blocks.map(block => {
    if (!block || !VALID_KINDS.has(block.type) || typeof block.text !== 'string'
      || block.text.length > 1000) throw new ValueError('Invalid message block');
    return block.type === 'bullet' ? '• ' + block.text : block.text;
  });
  const text = parts.join('\n').slice(0, MAX_TEXT);
  if (!text) throw new ValueError('Empty rich message');
  const keyboard = buttons.map(button => {
    if (!button || typeof button.text !== 'string' || button.text.length < 1
        || button.text.length > 48 || typeof button.callback !== 'string'
        || !/^[a-zA-Z0-9:_-]{1,64}$/.test(button.callback)) {
      throw new ValueError('Invalid button');
    }
    return [{text: button.text, callback_data: button.callback}];
  });
  return {text, ...(keyboard.length ? {reply_markup: {inline_keyboard: keyboard}} : {})};
}

class ValueError extends Error {}

/** One command/reply contract; invoke only after checking private owner identity. */
export async function handleAdminCommand(env, name, args, helpers = {}) {
  if (!name.startsWith('/admin') && !['/modchat', '/modterm', '/modterms', '/modrate'].includes(name)) {
    return null;
  }
  if (!helpers.ownerId || String(helpers.actorId) !== String(helpers.ownerId)) {
    return 'This administration command is owner-only.';
  }
  const usage = 'Admin: /adminfeatures; /adminfeature NAME on|off; /modchat CHAT on|off; '
    + '/modterm CHAT add|remove WORD; /modterms CHAT; /modrate CHAT COUNT SECONDS; '
    + '/admingate CHAT on|off; /adminrole USER_ID moderator|viewer|disabled; '
    + '/adminquota USER_ID archive|download|broadcast|api LIMIT; '
    + '/adminplan add SLUG PRICE_MINOR INR|USD|XTR; /adminplans; /adminstats';
  switch (name) {
    case '/adminhelp': return usage;
    case '/adminfeatures': {
      const list = await rows(env, helpers, 'SELECT name,enabled FROM admin_feature_flags ORDER BY name');
      return list.map(x => x.name + ': ' + (x.enabled ? 'ON' : 'OFF')).join('\n');
    }
    case '/adminfeature': {
      const [requested, state] = args;
      if (!FEATURES.has(requested) || !['on', 'off'].includes(state) || args.length !== 2) return usage;
      await q(env, helpers, 'UPDATE admin_feature_flags SET enabled=? WHERE name=?',
        state === 'on' ? 1 : 0, requested).run();
      await audit(env, helpers, 'admin_feature', requested + ':' + state);
      return 'Admin feature ' + requested + ': ' + state.toUpperCase();
    }
    case '/modchat': {
      const [chat, state] = args;
      if (!validChat(chat) || !['on', 'off'].includes(state) || args.length !== 2) return usage;
      await q(env, helpers, 'INSERT INTO admin_moderation_chats(chat,enabled) VALUES(?,?) '
        + 'ON CONFLICT(chat) DO UPDATE SET enabled=excluded.enabled', chat, Number(state === 'on')).run();
      await audit(env, helpers, 'moderation_chat', chat + ':' + state);
      return 'Chat moderation ' + chat + ': ' + state.toUpperCase()
        + '. Global /adminfeature moderation on is also required.';
    }
    case '/modterm': {
      const [chat, op] = args;
      const term = args.slice(2).join(' ').trim().toLocaleLowerCase();
      if (!validChat(chat) || !['add', 'remove'].includes(op) || term.length < 2
        || term.length > 80 || args.length < 3) return usage;
      if (op === 'add') {
        const count = (await q(env, helpers, 'SELECT count(*) AS n FROM admin_blocked_terms WHERE chat=?', chat).first())?.n;
        if (Number(count) >= MAX_TERMS) return 'Limit of 30 blocklist terms per chat reached.';
        await q(env, helpers, 'INSERT OR IGNORE INTO admin_blocked_terms(chat,term) VALUES(?,?)', chat, term).run();
      } else {
        await q(env, helpers, 'DELETE FROM admin_blocked_terms WHERE chat=? AND term=?', chat, term).run();
      }
      await audit(env, helpers, 'moderation_term', chat + ':' + op);
      return 'Blocklist term ' + (op === 'add' ? 'added' : 'removed') + ' for ' + chat + '.';
    }
    case '/modterms': {
      const chat = args[0];
      if (!validChat(chat) || args.length !== 1) return usage;
      const all = await rows(env, helpers, 'SELECT term FROM admin_blocked_terms WHERE chat=? ORDER BY id LIMIT 30', chat);
      return all.length ? all.map(x => x.term).join('\n') : 'No blocklist terms.';
    }
    case '/modrate': {
      const [chat] = args;
      const threshold = safeInt(args[1], 2, 30);
      const window = safeInt(args[2], 10, 3600);
      if (!validChat(chat) || threshold === null || window === null || args.length !== 3) return usage;
      await q(env, helpers, 'INSERT INTO admin_moderation_chats(chat,enabled,flood_limit,flood_window) '
        + 'VALUES(?,0,?,?) ON CONFLICT(chat) DO UPDATE SET flood_limit=excluded.flood_limit,'
        + 'flood_window=excluded.flood_window', chat, threshold, window).run();
      await audit(env, helpers, 'moderation_rate', chat);
      return 'Anti-flood threshold: ' + threshold + ' messages per ' + window + ' seconds in ' + chat + '.';
    }
    case '/admingate': {
      const [chat, state] = args;
      if (!validChat(chat) || !['on', 'off'].includes(state) || args.length !== 2) return usage;
      if (state === 'on') {
        const count = (await q(env, helpers, 'SELECT count(*) AS n FROM admin_required_chats WHERE enabled=1').first())?.n;
        if (count >= 3 && !(await q(env, helpers,
          'SELECT 1 FROM admin_required_chats WHERE chat=? AND enabled=1', chat).first())) {
          return 'At most three required membership chats are supported.';
        }
      }
      await q(env, helpers, 'INSERT INTO admin_required_chats(chat,enabled) VALUES(?,?) '
        + 'ON CONFLICT(chat) DO UPDATE SET enabled=excluded.enabled', chat, Number(state === 'on')).run();
      await audit(env, helpers, 'membership_gate', chat + ':' + state);
      return 'Membership requirement for ' + chat + ': ' + state.toUpperCase()
        + '. Global /adminfeature member_gate on is also required.';
    }
    case '/adminrole': {
      const id = parseTelegramUserId(args[0]);
      const role = args[1];
      if (!id || !ROLES.has(role) || args.length !== 2 || String(id) === String(helpers.ownerId)) return usage;
      await q(env, helpers, 'INSERT INTO admin_roles(user_id,role,assigned_at) VALUES(?,?,?) '
        + 'ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,assigned_at=excluded.assigned_at',
      String(id), role, now(helpers)).run();
      await audit(env, helpers, 'role_assigned', String(id));
      return 'Role saved for ' + id + ': ' + role + '. Only moderator actions in explicitly enabled '
        + 'group chats are delegated after /adminfeature roles on, with an /adminquota USER_ID api LIMIT.';
    }
    case '/adminquota': {
      const id = parseTelegramUserId(args[0]);
      const action = args[1];
      const limit = safeInt(args[2], 0, 5000);
      if (!id || !QUOTA_ACTIONS.has(action) || limit === null || args.length !== 3
        || String(id) === String(helpers.ownerId)) return usage;
      await q(env, helpers, 'INSERT INTO admin_quotas(user_id,action,daily_limit) VALUES(?,?,?) '
        + 'ON CONFLICT(user_id,action) DO UPDATE SET daily_limit=excluded.daily_limit', String(id), action, limit).run();
      await audit(env, helpers, 'quota_saved', String(id) + ':' + action);
      return 'Daily quota saved. Enforcement requires caller to use checkAndConsumeQuota.';
    }
    case '/adminplan': {
      if (args[0] !== 'add' || args.length !== 4 || !/^[a-z][a-z0-9_-]{1,31}$/.test(args[1] || '')
        || !['INR','USD','XTR'].includes(args[3])) return usage;
      const amount = safeInt(args[2], 0, 100000000);
      if (amount === null) return usage;
      await q(env, helpers,
        'INSERT OR IGNORE INTO admin_plans(slug,price_minor,currency,created_at) VALUES(?,?,?,?)',
        args[1], amount, args[3], now(helpers)).run();
      await audit(env, helpers, 'plan_created', args[1]);
      return 'Draft plan saved, inactive. No checkout or payment provider is connected.';
    }
    case '/adminplans': {
      const all = await rows(env, helpers, 'SELECT id,slug,price_minor,currency,active FROM admin_plans ORDER BY id LIMIT 20');
      return all.length ? all.map(x => '#' + x.id + ' ' + x.slug + ' '
        + x.price_minor + ' ' + x.currency + (x.active ? ' ACTIVE' : ' INACTIVE')).join('\n')
        : 'No plans configured. Payments are not connected.';
    }
    case '/adminstats': {
      const stats = await adminSnapshot(env, helpers);
      return Object.entries(stats.stats).map(([key, count]) => key + ': ' + count).join('\n');
    }
    default: return null;
  }
}

/** Quotas have no effect until the caller opts in and invokes this function. */
export async function checkAndConsumeQuota(env, userId, action, helpers = {}) {
  const id = parseTelegramUserId(userId);
  if (!id || !QUOTA_ACTIONS.has(action)) return {allowed: false, reason: 'invalid'};
  if (String(id) === String(helpers.ownerId)) return {allowed: true, reason: 'owner'};
  if (!(await feature(env, helpers, 'roles'))) return {allowed: true, reason: 'disabled'};
  const role = await q(env, helpers, 'SELECT role FROM admin_roles WHERE user_id=?', String(id)).first();
  if (role?.role === 'disabled') return {allowed: false, reason: 'role_disabled'};
  const quota = await q(env, helpers, 'SELECT daily_limit FROM admin_quotas WHERE user_id=? AND action=?',
    String(id), action).first();
  if (!quota) return {allowed: false, reason: 'no_quota'};
  if (!quota.daily_limit) return {allowed: false, reason: 'zero_quota'};
  const day = new Date(now(helpers) * 1000).toISOString().slice(0, 10);
  const used = await q(env, helpers,
    'INSERT INTO admin_quota_usage(user_id,action,day,used) VALUES(?,?,?,1) '
    + 'ON CONFLICT(user_id,action,day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used',
    String(id), action, day, quota.daily_limit).first();
  return {allowed: Boolean(used), remaining: used ? quota.daily_limit - used.used : 0};
}

/** Owner always allowed; delegated permissions are opt-in, scoped and read-only by default. */
export async function checkAdminRole(env, userId, permission, helpers = {}) {
  const id = parseTelegramUserId(userId);
  if (!id || !['read', 'moderate', 'configure'].includes(permission)) return false;
  if (String(id) === String(helpers.ownerId)) return true;
  if (!(await feature(env, helpers, 'roles'))) return false;
  if (permission === 'configure') return false;
  const record = await q(env, helpers, 'SELECT role FROM admin_roles WHERE user_id=?', String(id)).first();
  return record?.role === 'moderator' || (permission === 'read' && record?.role === 'viewer');
}

/** Membership gate is opt-in. It never joins chats, collects sessions or sends ads. */
export async function checkRequiredMembership(env, userId, helpers = {}) {
  const id = parseTelegramUserId(userId);
  if (!id) return false;
  if (String(id) === String(helpers.ownerId)) return true;
  if (!(await feature(env, helpers, 'member_gate'))) return true;
  if (typeof helpers.telegram !== 'function') return false;
  const chats = await rows(env, helpers, 'SELECT chat FROM admin_required_chats WHERE enabled=1 LIMIT 3');
  for (const chat of chats) {
    try {
      const member = await helpers.telegram('getChatMember', {chat_id: chat.chat, user_id: id});
      const good = ['creator','administrator','member'].includes(member?.status)
        || (member?.status === 'restricted' && member.is_member);
      if (!good) return false;
    } catch { return false; }
  }
  return true;
}

/**
 * Optionally delete harmful messages only in explicitly configured groups.
 * No invites, account sessions, auto bans, broad surveillance or content logs.
 */
export async function handleAdminUpdate(env, message, helpers = {}) {
  if (!message || !['supergroup','group'].includes(message.chat?.type) || !validPositiveId(message.message_id)
    || message.from?.is_bot || message.via_bot || message.sender_chat || message.has_protected_content
    || String(message.from?.id) === String(helpers.ownerId)) return {blocked: false};
  const chat = String(message.chat.id);
  const chatConfig = await q(env, helpers,
    'SELECT enabled,flood_limit,flood_window FROM admin_moderation_chats WHERE chat=?', chat).first();
  if (!chatConfig?.enabled) return {blocked: false};
  const moderate = await feature(env, helpers, 'moderation');
  const flood = await feature(env, helpers, 'antiflood');
  if (!moderate && !flood) return {blocked: false};
  const seen = await q(env, helpers,
    'SELECT blocked FROM admin_moderation_seen WHERE chat=? AND message_id=?', chat, message.message_id).first();
  if (seen) return {blocked: Boolean(seen.blocked), duplicate: true};
  const excerpt = String(message.text || message.caption || '').toLocaleLowerCase().slice(0, 2048);
  let reason = '';
  if (moderate && excerpt) {
    const terms = await rows(env, helpers, 'SELECT term FROM admin_blocked_terms WHERE chat=? LIMIT 30', chat);
    if (terms.some(item => excerpt.includes(item.term))) reason = 'keyword';
  }
  if (flood && !reason && parseTelegramUserId(message.from?.id)) {
    const userId = String(message.from.id);
    const time = now(helpers);
    await q(env, helpers, 'INSERT INTO admin_antiflood(chat,user_id,window_start,messages) VALUES(?,?,?,1) '
      + 'ON CONFLICT(chat,user_id) DO UPDATE SET '
      + 'window_start=CASE WHEN window_start<? THEN excluded.window_start ELSE window_start END,'
      + 'messages=CASE WHEN window_start<? THEN 1 ELSE messages+1 END',
      chat, userId, time, time - chatConfig.flood_window, time - chatConfig.flood_window).run();
    const counter = await q(env, helpers,
      'SELECT messages FROM admin_antiflood WHERE chat=? AND user_id=?', chat, userId).first();
    if (Number(counter?.messages || 0) > chatConfig.flood_limit) reason = 'flood';
  }
  const blocked = Boolean(reason);
  await q(env, helpers,
    'INSERT OR IGNORE INTO admin_moderation_seen(chat,message_id,handled_at,blocked) VALUES(?,?,?,?)',
    chat, message.message_id, now(helpers), Number(blocked)).run();
  if (blocked) {
    try { await helpers.telegram?.('deleteMessage', {chat_id: message.chat.id, message_id: message.message_id}); }
    catch { /* Still prevent this policy-rejected message entering the archive. */ }
    await audit(env, helpers, 'moderation_' + reason, chat);
  }
  return {blocked, reason: reason || null};
}

export async function runAdminScheduled(env, helpers = {}) {
  const time = now(helpers);
  const last = await q(env, helpers, 'SELECT value FROM settings WHERE key=?', 'admin_last_cleanup').first();
  if (time - Number(last?.value || 0) < 86400) return;
  await q(env, helpers, 'DELETE FROM admin_moderation_seen WHERE handled_at<?', time - 7 * 86400).run();
  await q(env, helpers, 'DELETE FROM admin_antiflood WHERE window_start<?', time - 86400).run();
  await q(env, helpers, 'DELETE FROM admin_quota_usage WHERE day<?',
    new Date((time - 45 * 86400) * 1000).toISOString().slice(0, 10)).run();
  await q(env, helpers, 'DELETE FROM admin_audit WHERE at<?', time - 90 * 86400).run();
  await q(env, helpers,
    'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    'admin_last_cleanup', String(time)).run();
}

/** Explicitly inert until a real, independently reviewed payment integration is supplied. */
export function createPaymentAdapter() {
  return Object.freeze({
    async createCheckout() { throw new Error('Payment provider is not configured'); },
    async verifyWebhook() { throw new Error('Payment provider is not configured'); },
    async refund() { throw new Error('Payment provider is not configured'); },
  });
}

export async function adminSnapshot(env, helpers = {}) {
  const counts = {};
  const count = async (name, table) => {
    counts[name] = Number((await q(env, helpers, 'SELECT count(*) AS n FROM ' + table).first())?.n || 0);
  };
  await count('routes', 'routes');
  await count('queued_jobs', 'jobs WHERE state=\'queued\'');
  await count('media_jobs', 'media_jobs');
  await count('manual_jobs', 'manual_jobs');
  await count('known_topics', 'topics');
  await count('saved_items', 'archive_items');
  await count('moderated_chats', 'admin_moderation_chats WHERE enabled=1');
  await count('configured_plans', 'admin_plans');
  const routeRows = await rows(env, helpers,
    'SELECT id,source,topic,dest,dest_topic,mode,enabled FROM routes ORDER BY id DESC LIMIT 25');
  const archiveRows = await rows(env, helpers,
    'SELECT source,source_message_id,dest,dest_topic,media_kind,filename,saved_at FROM archive_items ORDER BY id DESC LIMIT 20');
  const deliveryRows = await rows(env, helpers,
    'SELECT id,route_id,state,attempts,due FROM jobs ORDER BY id DESC LIMIT 20');
  const mediaRows = await rows(env, helpers,
    'SELECT id,kind,dest,dest_topic,state,attempts,due FROM media_jobs ORDER BY id DESC LIMIT 20');
  const manualRows = await rows(env, helpers,
    'SELECT id,state,attempts,due FROM manual_jobs ORDER BY id DESC LIMIT 20');
  const topicRows = await rows(env, helpers,
    'SELECT chat,thread,title FROM topics ORDER BY chat,thread LIMIT 50');
  const queues = [
    ...deliveryRows.map(r => ({kind: 'relay', id: r.id, target: 'route #' + r.route_id,
      state: r.state, attempts: r.attempts, due: r.due})),
    ...mediaRows.map(r => ({kind: r.kind, id: r.id, target: r.dest + '/' + r.dest_topic,
      state: r.state, attempts: r.attempts, due: r.due})),
    ...manualRows.map(r => ({kind: 'manual', id: r.id, target: 'telegram',
      state: r.state, attempts: r.attempts, due: r.due})),
  ];
  return {stats: counts, routes: routeRows, archive: archiveRows, queues, topics: topicRows};
}

function constantTimeKeyEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length > 512 || right.length > 512) return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let different = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) different |= (a[i] || 0) ^ (b[i] || 0);
  return different === 0;
}

const securityHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
};

/** Serve a read-only dashboard, never revealing data without an independent key. */
export async function handleAdminHttp(request, env, helpers = {}) {
  const path = new URL(request.url).pathname;
  if (!['/admin','/admin/','/admin/app.js','/admin/api'].includes(path)) return null;
  if (request.method !== 'GET') return new Response('Method not allowed', {status: 405, headers: securityHeaders});
  if (!(await feature(env, helpers, 'dashboard'))) return new Response('Not found', {status: 404});
  if (path === '/admin' || path === '/admin/') {
    return new Response(DASHBOARD_HTML, {headers: {...securityHeaders, 'Content-Type': 'text/html; charset=utf-8'}});
  }
  if (path === '/admin/app.js') {
    return new Response(DASHBOARD_SCRIPT, {headers: {...securityHeaders,
      'Content-Type': 'text/javascript; charset=utf-8'}});
  }
  const key = env.ORBIT_DASHBOARD_KEY;
  if (typeof key !== 'string' || key.length < 24) {
    return new Response('Dashboard key is not configured', {status: 503, headers: securityHeaders});
  }
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
  if (!constantTimeKeyEqual(supplied, key)) {
    return new Response('Forbidden', {status: 403, headers: securityHeaders});
  }
  try {
    return Response.json(await adminSnapshot(env, helpers), {headers: securityHeaders});
  } catch {
    return new Response('Dashboard unavailable', {status: 503, headers: securityHeaders});
  }
}
