/** Optional, owner-only messaging enhancements for a Bot API-only relay.
 *
 * All methods work with Cloudflare D1 and the local node:sqlite adapter. No
 * userbot, session string, source-history scraper, or media download is used.
 * The caller must authenticate owner commands before calling the dispatcher.
 */
import {
  eligible, fileMetadata, classifyError, validPositiveId, validTopic,
} from './core.js';

const MAX_RANGE = 10000;
const RANGE_CHUNK = 40;
const MAX_ALBUM = 10;
const ALBUM_QUIET_SECONDS = 4;
const MAX_QUEUED = 1500;
const MAX_DAILY = 200;
const TEMPLATE_FIELDS = [
  'kind', 'mode', 'include_text', 'exclude_text', 'caption_template',
  'sender_id', 'min_bytes', 'max_bytes', 'auto_topics', 'sync_topic_titles',
  'propagate_edits', 'regex_include', 'regex_exclude', 'mime_csv',
  'extension_csv', 'date_from', 'date_to', 'window_utc', 'weekdays_csv',
];
const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const get = (env, sql, ...args) => query(env, sql, ...args).first();
const all = async (env, sql, ...args) => (await query(env, sql, ...args).all()).results || [];
const epoch = () => Math.floor(Date.now() / 1000);
const integer = raw => /^\d+$/.test(String(raw ?? '')) ? Number(raw) : NaN;

function exactUtcDate(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(raw + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

/**
 * Intentionally tiny regex dialect. Character classes, anchors, alternation,
 * escapes, dot and ONE `.*` wildcard work. No arbitrary quantifiers, groups,
 * backreferences, lookaround, or repeated wildcards are accepted. This avoids
 * user-supplied catastrophic-backtracking patterns in JavaScript Workers.
 */
export function safeRegex(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 96
      || /[\r\n\x00-\x1f]/.test(pattern) || /[(){}+?]/.test(pattern)) return null;
  let wildcards = 0;
  let classOpen = false;
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') {
      i++;
      if (i >= pattern.length || /[1-9]/.test(pattern[i])) return null;
      continue;
    }
    if (char === '[' && !classOpen) { classOpen = true; continue; }
    if (char === ']' && classOpen) { classOpen = false; continue; }
    if (char === '*' && !classOpen) {
      if (pattern[i - 1] !== '.' || ++wildcards > 1) return null;
    }
    if (char === '[' && classOpen) return null;
  }
  if (classOpen) return null;
  try { return new RegExp(pattern, 'i'); } catch { return null; }
}

function csvTokens(value) {
  return String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

function attachment(message) {
  for (const type of ['document', 'video', 'audio', 'voice', 'animation', 'sticker']) {
    if (message?.[type]) return message[type];
  }
  return null;
}

/** A route's extra content filters; run after core.eligible(). */
export function matchesExtendedFilters(message, route) {
  if (!eligible(message, route)) return false;
  const text = String(message.text || message.caption || '').slice(0, 2500);
  if (route.regex_include && !safeRegex(route.regex_include)?.test(text)) return false;
  if (route.regex_exclude && (!safeRegex(route.regex_exclude) || safeRegex(route.regex_exclude).test(text))) return false;
  const file = attachment(message);
  const mimeRules = csvTokens(route.mime_csv);
  if (mimeRules.length) {
    const mime = String(file?.mime_type || '').toLowerCase();
    if (!mimeRules.some(rule => rule === mime || (rule.endsWith('/*') && mime.startsWith(rule.slice(0, -1))))) return false;
  }
  const extRules = csvTokens(route.extension_csv);
  if (extRules.length) {
    const filename = String(file?.file_name || '').toLowerCase();
    if (!extRules.some(ext => filename.endsWith('.' + ext))) return false;
  }
  const messageDate = Number(message.date);
  if ((route.date_from || route.date_to) && !Number.isSafeInteger(messageDate)) return false;
  if (route.date_from && (!exactUtcDate(route.date_from) || messageDate < Date.parse(route.date_from + 'T00:00:00Z') / 1000)) return false;
  if (route.date_to && (!exactUtcDate(route.date_to) || messageDate >= Date.parse(route.date_to + 'T00:00:00Z') / 1000 + 86400)) return false;
  return true;
}

function parseWindow(route) {
  const raw = route.window_utc;
  if (!raw) return null;
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(raw);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (+match[1] > 23 || +match[2] > 59 || +match[3] > 23 || +match[4] > 59 || start === end) return null;
  return {start, end};
}

/** First UTC instant at which this route may send. Scheduling never drops data. */
export function nextDeliveryTime(route, currentSeconds = epoch()) {
  const window = parseWindow(route);
  if (route.window_utc && !window) return null;
  const rawDays = csvTokens(route.weekdays_csv);
  const allowedDays = rawDays.length ? rawDays.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  if (!window && !rawDays.length) return currentSeconds;
  if (!allowedDays.length || allowedDays.some(n => !Number.isInteger(n) || n < 0 || n > 6)) return null;
  const earliest = Math.max(0, Math.trunc(currentSeconds));
  const dayStart = Math.floor(earliest / 86400) * 86400;
  for (let dayIndex = -1; dayIndex < 8; dayIndex++) {
    const midnight = dayStart + dayIndex * 86400;
    const day = new Date(midnight * 1000).getUTCDay();
    if (!allowedDays.includes(day)) continue;
    const start = midnight + (window?.start ?? 0) * 60;
    const end = midnight + (window?.end ?? 1440) * 60 + (window && window.end < window.start ? 86400 : 0);
    if (earliest < end) return Math.max(earliest, start);
  }
  return null;
}

/** An existing mapping only, for jobs created before destination-topic lookup. */
export async function mappedTopic(env, routeId, sourceTopic) {
  const topic = await get(env, "SELECT destination_topic FROM topic_mappings WHERE route_id=? AND source_topic=? AND state='ready'",
    routeId, sourceTopic);
  return validPositiveId(topic?.destination_topic) ? topic.destination_topic : null;
}

/** Exactly-one automatic topic create; uncertain creations require manual review. */
export async function ensureMappedTopic(env, route, sourceTopic, sourceTitle, telegram,
  nowSeconds = epoch()) {
  if (!Number(route.auto_topics) || !validPositiveId(sourceTopic)) return Number(route.dest_topic || 0);
  if (Number(route.dest_topic) !== 0 || route.source === route.dest) return null;
  const existing = await get(env, 'SELECT * FROM topic_mappings WHERE route_id=? AND source_topic=?', route.id, sourceTopic);
  if (existing) return existing.state === 'ready' ? existing.destination_topic : null;
  const name = String(sourceTitle || 'Topic ' + sourceTopic).trim().slice(0, 128);
  const inserted = await query(env,
    "INSERT OR IGNORE INTO topic_mappings(route_id,source_topic,title,state,updated_at) VALUES(?,?,?,'creating',?)",
    route.id, sourceTopic, name, nowSeconds).run();
  if (!inserted.meta?.changes) return null;
  try {
    const created = await telegram('createForumTopic', {chat_id: route.dest, name});
    if (!validPositiveId(created?.message_thread_id)) throw new Error('Missing topic ID');
    await query(env,
      "UPDATE topic_mappings SET destination_topic=?,state='ready',updated_at=? WHERE route_id=? AND source_topic=? AND state='creating'",
      created.message_thread_id, nowSeconds, route.id, sourceTopic).run();
    return created.message_thread_id;
  } catch (error) {
    await query(env, "UPDATE topic_mappings SET state='uncertain',updated_at=? WHERE route_id=? AND source_topic=? AND state='creating'",
      nowSeconds, route.id, sourceTopic).run();
    return null;
  }
}

export async function syncTopicTitle(env, route, sourceTopic, title, telegram,
  nowSeconds = epoch()) {
  const name = String(title || '').trim();
  if (!Number(route.sync_topic_titles) || !Number(route.auto_topics) || !validPositiveId(sourceTopic)
      || !name || name.length > 128) return false;
  const mapping = await get(env,
    "SELECT * FROM topic_mappings WHERE route_id=? AND source_topic=? AND state='ready'",
    route.id, sourceTopic);
  if (!validPositiveId(mapping?.destination_topic)) return false;
  if (mapping.title === name) return true;
  try {
    await telegram('editForumTopic', {chat_id: route.dest, message_thread_id: mapping.destination_topic, name});
    await query(env, 'UPDATE topic_mappings SET title=?,updated_at=? WHERE route_id=? AND source_topic=?',
      name, nowSeconds, route.id, sourceTopic).run();
    return true;
  } catch { return false; }
}

/** Add one album member; caller excludes it from ordinary single-message jobs. */
export async function enqueueAlbumMessage(env, route, message, opts = {}) {
  if (!matchesExtendedFilters(message, route) || !message.media_group_id) return {handled: false};
  if (route.caption_template) return {handled: false, reason: 'caption-template-requires-single-copy'};
  if (!['copy', 'forward'].includes(route.mode)) return {handled: false};
  const group = String(message.media_group_id);
  if (!/^[\w-]{1,128}$/.test(group) || !validPositiveId(message.message_id)) return {handled: false};
  const nowSeconds = opts.nowSeconds ?? epoch();
  const sourceTopic = Number(message.message_thread_id || 0);
  const destinationTopic = opts.destinationTopic ?? Number(route.dest_topic || 0);
  if (!validTopic(destinationTopic)) return {handled: true, queued: false, reason: 'topic-unavailable'};
  const due = nextDeliveryTime(route, nowSeconds);
  if (due == null) return {handled: true, queued: false, reason: 'invalid-schedule'};
  await query(env,
    "INSERT OR IGNORE INTO album_batches(route_id,group_id,source_topic,dest_topic,state,due,first_at,last_at) VALUES(?,?,?,?,'queued',?,?,?)",
    route.id, group, sourceTopic, destinationTopic, Math.max(due, nowSeconds + ALBUM_QUIET_SECONDS), nowSeconds, nowSeconds).run();
  const batch = await get(env, 'SELECT * FROM album_batches WHERE route_id=? AND group_id=?', route.id, group);
  if (!batch || batch.state !== 'queued' || batch.dest_topic !== destinationTopic) {
    return {handled: true, queued: false, reason: 'album-not-accepting'};
  }
  const count = await get(env, 'SELECT count(*) AS n FROM album_members WHERE batch_id=?', batch.id);
  if (count.n >= MAX_ALBUM) {
    await query(env, "UPDATE album_batches SET state='uncertain',error='album has over 10 items' WHERE id=?", batch.id).run();
    return {handled: true, queued: false, reason: 'album-overflow'};
  }
  const meta = fileMetadata(message);
  await query(env,
    'INSERT OR IGNORE INTO album_members(batch_id,message_id,media_kind,filename,caption_preview) VALUES(?,?,?,?,?)',
    batch.id, message.message_id, meta.kind, meta.filename, meta.caption).run();
  const nextDue = Math.max(due, Math.min(nowSeconds + ALBUM_QUIET_SECONDS, batch.first_at + 12));
  await query(env, "UPDATE album_batches SET last_at=?,due=? WHERE id=? AND state='queued'",
    nowSeconds, nextDue, batch.id).run();
  return {handled: true, queued: true, batchId: batch.id};
}

async function dailyAllowance(env, nowSeconds, requested) {
  const day = new Date(nowSeconds * 1000).toISOString().slice(0, 10);
  const stored = await get(env, 'SELECT value FROM settings WHERE key=?', 'daily_day');
  let count = 0;
  if (stored?.value === day) count = Number((await get(env, 'SELECT value FROM settings WHERE key=?', 'daily_count'))?.value || 0);
  else {
    await query(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'daily_day', day).run();
    await query(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'daily_count', '0').run();
  }
  return count + requested <= MAX_DAILY;
}

async function bumpDaily(env, count) {
  await query(env, "UPDATE settings SET value=CAST(CAST(value AS INTEGER)+CAST(? AS INTEGER) AS TEXT) WHERE key='daily_count'", count).run();
}

/**
 * One album per cron invocation. API uncertainty is terminal until owner review.
 * The full returned MessageId list is required for unambiguous archival mapping.
 */
export async function drainAlbum(env, telegram, nowSeconds = epoch()) {
  const candidate = await get(env,
    "SELECT a.*,r.source,r.dest,r.mode,r.enabled FROM album_batches a JOIN routes r ON r.id=a.route_id " +
    "WHERE a.state='queued' AND a.due<=? AND r.enabled=1 ORDER BY a.id LIMIT 1", nowSeconds);
  if (!candidate) return {processed: false};
  const members = await all(env, 'SELECT * FROM album_members WHERE batch_id=? ORDER BY message_id', candidate.id);
  if (!members.length || members.length > MAX_ALBUM || !await dailyAllowance(env, nowSeconds, members.length)) {
    return {processed: false, reason: 'daily-cap-or-invalid-members'};
  }
  const claimed = await query(env,
    "UPDATE album_batches SET state='sending',claimed_at=? WHERE id=? AND state='queued'", nowSeconds, candidate.id).run();
  if (!claimed.meta?.changes) return {processed: false};
  const many = members.length > 1;
  const method = candidate.mode === 'forward'
    ? (many ? 'forwardMessages' : 'forwardMessage')
    : (many ? 'copyMessages' : 'copyMessage');
  const body = {
    chat_id: candidate.dest, from_chat_id: candidate.source,
    ...(many ? {message_ids: members.map(m => m.message_id)} : {message_id: members[0].message_id}),
    ...(candidate.dest_topic ? {message_thread_id: candidate.dest_topic} : {}),
    disable_notification: true,
  };
  try {
    const sent = await telegram(method, body);
    const destIds = many ? sent?.map(item => item?.message_id) : [sent?.message_id];
    if (!Array.isArray(destIds) || destIds.length !== members.length || destIds.some(id => !validPositiveId(id))) {
      await query(env, "UPDATE album_batches SET state='uncertain',error='partial or malformed API result' WHERE id=?",
        candidate.id).run();
      return {processed: true, state: 'uncertain'};
    }
    await env.DB.batch(members.map((member, i) => query(env,
      'INSERT OR IGNORE INTO archive_items(source,source_message_id,dest,dest_topic,dest_message_id,route_id,media_kind,filename,caption_preview,saved_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      candidate.source, member.message_id, candidate.dest, candidate.dest_topic, destIds[i], candidate.route_id,
      member.media_kind, member.filename, member.caption_preview, nowSeconds)));
    await query(env, "UPDATE album_batches SET state='done',error=NULL WHERE id=?", candidate.id).run();
    await bumpDaily(env, members.length);
    return {processed: true, state: 'done', count: members.length};
  } catch (error) {
    const category = classifyError(error);
    if (category === 'rate_limit') {
      const due = nowSeconds + Math.max(60, Math.min(86400, Number(error.retry) || 60));
      await query(env, "UPDATE album_batches SET state='queued',due=?,error='rate limited' WHERE id=?", due, candidate.id).run();
      await query(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        'cooldown', String(due)).run();
      return {processed: true, state: 'queued', cooldown: due};
    }
    const state = category === 'halt' ? 'failed' : category;
    await query(env, 'UPDATE album_batches SET state=?,error=? WHERE id=?', state,
      'API ' + (Number(error.code) || 'transport'), candidate.id).run();
    if (category === 'halt') await query(env,
      'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      'stopped', '1').run();
    if (Number(error.code) === 403) await query(env, 'UPDATE routes SET enabled=0 WHERE id=?', candidate.route_id).run();
    return {processed: true, state};
  }
}

export async function createBatchRange(env, routeId, firstId, lastId, nowSeconds = epoch()) {
  if (!validPositiveId(firstId) || !validPositiveId(lastId) || lastId < firstId || lastId - firstId + 1 > MAX_RANGE) return null;
  const route = await get(env, 'SELECT * FROM routes WHERE id=? AND enabled=1', routeId);
  if (!route || Number(route.auto_topics) || route.source === route.dest) return null;
  const result = await query(env,
    "INSERT INTO batch_ranges(route_id,first_id,last_id,next_id,state,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)",
    routeId, firstId, lastId, firstId, nowSeconds, nowSeconds).run();
  return Number(result.meta?.last_row_id) || (await get(env, 'SELECT id FROM batch_ranges WHERE route_id=? AND first_id=? AND last_id=? ORDER BY id DESC LIMIT 1',
    routeId, firstId, lastId))?.id || null;
}

/** Checkpoint in the same database transaction as the deduplicated job inserts. */
export async function pumpBatchRange(env, nowSeconds = epoch()) {
  const batch = await get(env,
    "SELECT b.*,r.enabled,r.window_utc,r.weekdays_csv FROM batch_ranges b JOIN routes r ON r.id=b.route_id " +
    "WHERE b.state='queued' AND r.enabled=1 ORDER BY b.id LIMIT 1");
  if (!batch) return {processed: false};
  const pending = Number((await get(env, "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','sending','uncertain')"))?.n || 0);
  const count = Math.min(RANGE_CHUNK, MAX_QUEUED - pending, batch.last_id - batch.next_id + 1);
  if (count <= 0) return {processed: false, reason: 'queue-full'};
  const due = nextDeliveryTime(batch, nowSeconds);
  if (due == null) return {processed: false, reason: 'invalid-schedule'};
  const finished = batch.next_id + count > batch.last_id;
  const statements = [query(env,
    'UPDATE batch_ranges SET next_id=?,state=?,enqueued_count=enqueued_count+?,updated_at=? WHERE id=? AND state=? AND next_id=?',
    batch.next_id + count, finished ? 'done' : 'queued', count, nowSeconds, batch.id, 'queued', batch.next_id)];
  for (let id = batch.next_id; id < batch.next_id + count; id++) {
    statements.push(query(env, 'INSERT OR IGNORE INTO jobs(route_id,message_id,state,due) VALUES(?,?,?,?)',
      batch.route_id, id, 'queued', due));
  }
  const results = await env.DB.batch(statements);
  return {processed: Boolean(results[0]?.meta?.changes), count, batchId: batch.id, finished};
}

/** A copied bot-owned message may be edited when the original is edited. */
export async function propagateEditedMessage(env, message, route, telegram) {
  if (!Number(route.propagate_edits) || !matchesExtendedFilters(message, route)) return false;
  const archived = await get(env,
    'SELECT dest_message_id FROM archive_items WHERE route_id=? AND source=? AND source_message_id=? AND dest=? AND deleted_at IS NULL',
    route.id, route.source, message.message_id, route.dest);
  if (!validPositiveId(archived?.dest_message_id)) return false;
  const text = message.text ?? message.caption;
  if (typeof text !== 'string' || text.length === 0) return false;
  const isCaption = message.caption !== undefined;
  try {
    await telegram(isCaption ? 'editMessageCaption' : 'editMessageText', {
      chat_id: route.dest, message_id: archived.dest_message_id,
      [isCaption ? 'caption' : 'text']: text.slice(0, isCaption ? 1024 : 4096),
    });
    return true;
  } catch { return false; }
}

/** Confirmed archive mapping only: a deliberate owner-initiated delete. */
export async function deleteCopiedMessage(env, routeId, sourceMessageId, telegram, nowSeconds = epoch()) {
  const row = await get(env, 'SELECT a.* FROM archive_items a JOIN routes r ON r.id=a.route_id ' +
    'WHERE r.id=? AND a.source_message_id=? AND a.dest=r.dest AND a.source=r.source AND a.deleted_at IS NULL',
    routeId, sourceMessageId);
  if (!validPositiveId(row?.dest_message_id)) return false;
  try {
    await telegram('deleteMessage', {chat_id: row.dest, message_id: row.dest_message_id});
    await query(env, 'UPDATE archive_items SET deleted_at=? WHERE id=? AND deleted_at IS NULL', nowSeconds, row.id).run();
    return true;
  } catch { return false; }
}

/** Connect original reply to an already-confirmed destination copy, if present. */
export async function replyParameters(env, route, message, destinationTopic = Number(route.dest_topic || 0)) {
  const sourceReplyId = message.reply_to_message?.message_id;
  if (!validPositiveId(sourceReplyId)) return null;
  const copied = await get(env,
    'SELECT dest_message_id FROM archive_items WHERE route_id=? AND source=? AND source_message_id=? AND dest=? AND dest_topic=? AND deleted_at IS NULL',
    route.id, route.source, sourceReplyId, route.dest, destinationTopic);
  return validPositiveId(copied?.dest_message_id) ? {message_id: copied.dest_message_id} : null;
}

export async function saveRouteTemplate(env, name, routeId, nowSeconds = epoch()) {
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(name)) return false;
  const route = await get(env, 'SELECT * FROM routes WHERE id=?', routeId);
  if (!route) return false;
  const config = Object.fromEntries(TEMPLATE_FIELDS.map(key => [key, route[key] ?? null]));
  await query(env, 'INSERT INTO route_templates(name,config,updated_at) VALUES(?,?,?) ' +
    'ON CONFLICT(name) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at',
    name, JSON.stringify(config), nowSeconds).run();
  return true;
}

export async function applyRouteTemplate(env, name, routeId) {
  const template = await get(env, 'SELECT config FROM route_templates WHERE name=?', name);
  const route = await get(env, 'SELECT id,dest_topic FROM routes WHERE id=?', routeId);
  if (!template || !route) return false;
  let data;
  try { data = JSON.parse(template.config); } catch { return false; }
  if (typeof data !== 'object' || !data || TEMPLATE_FIELDS.some(field => !(field in data))) return false;
  if (Number(data.auto_topics) && Number(route.dest_topic)) return false;
  if ((data.regex_include && !safeRegex(data.regex_include)) || (data.regex_exclude && !safeRegex(data.regex_exclude))) return false;
  const fields = TEMPLATE_FIELDS.map(field => field + '=?').join(',');
  await query(env, 'UPDATE routes SET ' + fields + ' WHERE id=?',
    ...TEMPLATE_FIELDS.map(field => data[field]), routeId).run();
  return true;
}

/**
 * Called by the owner-only /command branch in index.js. Returns null for
 * unknown commands. helpers.telegram(method,body), helpers.now() optional.
 */
export async function handleMessagingCommand(env, name, args = [], helpers = {}) {
  const command = name.toLowerCase();
  const nowSeconds = helpers.now?.() ?? epoch();
  const id = integer(args[0]);
  const route = validPositiveId(id) ? await get(env, 'SELECT * FROM routes WHERE id=?', id) : null;
  if (command === '/autotopics' || command === '/topicsync' || command === '/editsync') {
    const field = command === '/autotopics' ? 'auto_topics' : command === '/topicsync' ? 'sync_topic_titles' : 'propagate_edits';
    if (!route || !['on', 'off'].includes(args[1])) return 'Usage: ' + command + ' ROUTE_ID on|off';
    if (field === 'auto_topics' && args[1] === 'on' && Number(route.dest_topic)) {
      return 'Auto topic creation requires destination topic 0 (a forum-enabled destination group).';
    }
    await query(env, 'UPDATE routes SET ' + field + '=? WHERE id=?', args[1] === 'on' ? 1 : 0, id).run();
    return 'Route #' + id + ' ' + field + ' ' + args[1] + '. Requires appropriate bot topic rights.';
  }
  if (command === '/routepattern') {
    const mode = args[1];
    const value = args.slice(2).join(' ').trim();
    if (!route || !['include', 'exclude', 'clear'].includes(mode)) {
      return 'Usage: /routepattern ROUTE_ID include|exclude SAFE_PATTERN or clear';
    }
    if (mode === 'clear') {
      await query(env, 'UPDATE routes SET regex_include=NULL,regex_exclude=NULL WHERE id=?', id).run();
      return 'Route regex filters cleared.';
    }
    if (!safeRegex(value)) return 'Invalid safe pattern: max 96 chars; no groups, backrefs, lookaround, or quantifiers except one .* wildcard.';
    await query(env, 'UPDATE routes SET ' + (mode === 'include' ? 'regex_include' : 'regex_exclude') + '=? WHERE id=?', value, id).run();
    return 'Safe regex filter saved for route #' + id + '.';
  }
  if (command === '/routefile') {
    const field = args[1] === 'mime' ? 'mime_csv' : args[1] === 'ext' ? 'extension_csv' : null;
    const value = String(args[2] || '').toLowerCase();
    if (!route || !field || (!/^[a-z0-9,._+/*-]{1,160}$/.test(value) && value !== 'clear')) {
      return 'Usage: /routefile ROUTE_ID mime application/pdf,image/* | ext pdf,zip | mime clear';
    }
    const tokens = csvTokens(value);
    if (value !== 'clear' && (tokens.length > 12 || (field === 'extension_csv'
      ? tokens.some(t => !/^[a-z0-9]{1,12}$/.test(t))
      : tokens.some(t => !/^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/.test(t))))) return 'Invalid MIME or extension list.';
    await query(env, 'UPDATE routes SET ' + field + '=? WHERE id=?', value === 'clear' ? null : value, id).run();
    return 'File filter saved for route #' + id + '.';
  }
  if (command === '/routedates') {
    const first = args[1], last = args[2];
    if (!route || !(first === 'clear' || (exactUtcDate(first) && exactUtcDate(last) && first <= last))) {
      return 'Usage: /routedates ROUTE_ID YYYY-MM-DD YYYY-MM-DD | clear';
    }
    await query(env, 'UPDATE routes SET date_from=?,date_to=? WHERE id=?',
      first === 'clear' ? null : first, first === 'clear' ? null : last, id).run();
    return 'Message date filter updated for route #' + id + '.';
  }
  if (command === '/routewindow') {
    const window = args[1];
    const days = args[2] || '';
    if (!route || !(window === 'clear' || (parseWindow({window_utc: window}) &&
      (!days || (/^[0-6](,[0-6]){0,6}$/.test(days) && new Set(days.split(',')).size === days.split(',').length))))) {
      return 'Usage: /routewindow ROUTE_ID HH:MM-HH:MM [UTC_WEEKDAYS_0to6] | clear';
    }
    await query(env, 'UPDATE routes SET window_utc=?,weekdays_csv=? WHERE id=?',
      window === 'clear' ? null : window, window === 'clear' ? null : (days || null), id).run();
    return 'UTC delivery schedule updated for route #' + id + '.';
  }
  if (command === '/routebatch') {
    const first = integer(args[1]), last = integer(args[2]);
    if (!route || !validPositiveId(first) || !validPositiveId(last) || last < first || last - first + 1 > MAX_RANGE) {
      return 'Usage: /routebatch ROUTE_ID FIRST LAST (1–10000 known IDs, inclusive)';
    }
    const created = await createBatchRange(env, id, first, last, nowSeconds);
    return created ? 'Checkpointed batch #' + created + ' queued: ' + (last - first + 1) +
      ' known IDs. No source history will be scraped.' : 'Batch refused; route must be enabled and must use a fixed destination topic.';
  }
  if (command === '/routebatches') {
    const batches = await all(env, 'SELECT * FROM batch_ranges ORDER BY id DESC LIMIT 12');
    return batches.length ? batches.map(b => '#' + b.id + ' route ' + b.route_id + ' ' + b.state +
      ' ' + b.enqueued_count + '/' + (b.last_id - b.first_id + 1)).join('\n') : 'No checkpointed batches.';
  }
  if (command === '/routebatchpause' || command === '/routebatchresume') {
    if (!validPositiveId(id)) return 'Usage: ' + command + ' BATCH_ID';
    const state = command === '/routebatchpause' ? 'paused' : 'queued';
    const previous = state === 'paused' ? 'queued' : 'paused';
    const changed = await query(env, 'UPDATE batch_ranges SET state=?,updated_at=? WHERE id=? AND state=?',
      state, nowSeconds, id, previous).run();
    return changed.meta?.changes ? 'Batch #' + id + ' ' + state + '.' : 'Batch not found or not in ' + previous + ' state.';
  }
  if (command === '/routetemplate') {
    const action = args[0], nameArg = args[1], target = integer(args[2]);
    if (action === 'list') {
      const templates = await all(env, 'SELECT name,updated_at FROM route_templates ORDER BY name LIMIT 30');
      return templates.length ? templates.map(t => t.name).join(', ') : 'No route templates.';
    }
    if (!['save', 'apply'].includes(action) || !validPositiveId(target)) {
      return 'Usage: /routetemplate save|apply NAME ROUTE_ID | list';
    }
    const worked = action === 'save' ? await saveRouteTemplate(env, nameArg, target, nowSeconds)
      : await applyRouteTemplate(env, nameArg, target);
    return worked ? 'Route template ' + nameArg + ' ' + (action === 'save' ? 'saved.' : 'applied.')
      : 'Template operation refused. Check route ID and template name.';
  }
  if (command === '/topicmaps') {
    const maps = await all(env, 'SELECT * FROM topic_mappings ORDER BY updated_at DESC LIMIT 15');
    return maps.length ? maps.map(m => 'Route #' + m.route_id + ' ' + m.source_topic + ' → ' +
      (m.destination_topic || '?') + ' [' + m.state + ']').join('\n') : 'No topic mappings.';
  }
  if (command === '/mirrorremove') {
    const sourceId = integer(args[1]);
    if (!route || !validPositiveId(sourceId) || args[2] !== 'CONFIRM') {
      return 'Usage: /mirrorremove ROUTE_ID SOURCE_MESSAGE_ID CONFIRM (deletes one confirmed destination copy)';
    }
    if (!helpers.telegram) return 'Telegram API helper is not configured.';
    return await deleteCopiedMessage(env, id, sourceId, helpers.telegram, nowSeconds)
      ? 'Confirmed destination copy deleted.'
      : 'Not deleted (no confirmed mapping, API limit, or insufficient permission).';
  }
  return null;
}

/** Optional convenience wrapper for one accepted routed message. */
export async function ingestMessagingUpdate(env, message, route, helpers = {}) {
  if (!matchesExtendedFilters(message, route)) return {accepted: false, handled: true};
  if ((await get(env, 'SELECT value FROM settings WHERE key=?', 'stopped'))?.value === '1') {
    return {accepted: false, handled: true, reason: 'stopped'};
  }
  const nowSeconds = helpers.now?.() ?? epoch();
  const sourceTopic = Number(message.message_thread_id || 0);
  let destinationTopic = Number(route.dest_topic || 0);
  if (Number(route.auto_topics) && sourceTopic > 0) {
    if (!helpers.telegram) return {accepted: false, handled: true, reason: 'telegram-helper-missing'};
    const topicTitle = (await get(env, 'SELECT title FROM topics WHERE chat=? AND thread=?', route.source, sourceTopic))?.title;
    destinationTopic = await ensureMappedTopic(env, route, sourceTopic, topicTitle, helpers.telegram, nowSeconds);
    if (!validPositiveId(destinationTopic)) return {accepted: false, handled: true, reason: 'topic-unavailable'};
  }
  if (message.media_group_id) {
    const album = await enqueueAlbumMessage(env, route, message, {destinationTopic, nowSeconds});
    if (album.handled) return {accepted: true, handled: true, ...album};
  }
  return {accepted: true, handled: false, destinationTopic,
    replyParameters: await replyParameters(env, route, message, destinationTopic),
    due: nextDeliveryTime(route, nowSeconds)};
}

/** Helper invoked from scheduled(); does not bypass /stop or cooldown. */
export async function runMessagingScheduled(env, helpers = {}) {
  const nowSeconds = helpers.now?.() ?? epoch();
  if ((await get(env, 'SELECT value FROM settings WHERE key=?', 'stopped'))?.value === '1') return {skipped: 'stopped'};
  const cooldown = Number((await get(env, 'SELECT value FROM settings WHERE key=?', 'cooldown'))?.value || 0);
  if (cooldown > nowSeconds) return {skipped: 'cooldown'};
  await query(env, "UPDATE album_batches SET state='uncertain',error='send interrupted; review before retry' " +
    "WHERE state='sending' AND claimed_at<?", nowSeconds - 300).run();
  await query(env, "UPDATE topic_mappings SET state='uncertain',updated_at=? " +
    "WHERE state='creating' AND updated_at<?", nowSeconds, nowSeconds - 300).run();
  const batch = await pumpBatchRange(env, nowSeconds);
  const album = helpers.telegram ? await drainAlbum(env, helpers.telegram, nowSeconds) : {processed: false};
  return {batch, album};
}
