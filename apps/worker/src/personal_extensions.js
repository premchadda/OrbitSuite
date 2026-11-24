/**
 * Optional, small-scale personal automation for OrbitSuite. No session login,
 * arbitrary code execution, background joining, or unapproved broadcasts.
 *
 * Integration contract:
 *   handlePersonalCommand(env, name, args, helpers) -> string|null
 *   ingestPersonalUpdate(env, update, helpers) -> boolean
 *   runPersonalScheduled(env, helpers) -> number
 * helpers: query(sql,...args).run/first, rows(sql,...args),
 *          telegram(method,body), ownerId, now, fetchRss(url).
 */
import {runTextInference} from './ai_inference.js';

const now = helpers => Number(helpers.now?.() ?? Math.floor(Date.now() / 1000));
const textLimit = (value, n) => String(value ?? '').trim().slice(0, n);
const isChat = value => /^-100\d{5,16}$/.test(String(value));
const id = raw => /^\d+$/.test(String(raw ?? '')) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0
  ? Number(raw) : null;
const short = (raw, n = 80) => String(raw ?? '').slice(0, n);

async function enabled(helpers, feature) {
  const row = await helpers.query('SELECT enabled FROM feature_flags WHERE feature=?', feature).first();
  return row?.enabled === 1;
}

function partsByPipe(raw, count) {
  const fields = raw.split('|').map(s => s.trim());
  return fields.length === count && fields.every(Boolean) ? fields : null;
}

function parseFeedHosts(env) {
  return String(env.ORBIT_RSS_HOSTS || '').split(',').map(s => s.trim().toLowerCase())
    .filter(host => /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host));
}

/** Restrict service-fed RSS URLs to explicit operator allowlist entries. */
export function safeFeedUrl(raw, allowedHosts) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return String(raw).length <= 2048 && url.protocol === 'https:'
    && !url.username && !url.password && !url.port && !url.hash
    && !/^\d+(?:\.\d+){3}$/.test(host) && !host.includes(':')
    && !host.endsWith('.local') && !host.endsWith('.internal')
    && allowedHosts.some(item => host === item || host.endsWith('.' + item));
}

/** Only call a configured token-authenticated HTTPS parser; the self-hosted
 * parser owns DNS pinning and rejects redirects on outgoing lookup requests.
 */
async function fetchParserJson(env, path, parameters, fetchImpl) {
  let endpoint;
  try { endpoint = new URL(env.ORBIT_RSS_PARSER_URL); } catch { throw new Error('RSS parser not configured'); }
  const token = String(env.ORBIT_RSS_PARSER_TOKEN || '');
  const local = env.ORBIT_RSS_ALLOW_LOCAL_HTTP === '1'
    && endpoint.protocol === 'http:' && ['127.0.0.1','localhost'].includes(endpoint.hostname)
    && endpoint.port === '8188';
  const remote = endpoint.protocol === 'https:' && endpoint.hostname && !endpoint.port;
  if ((!local && !remote) || endpoint.username || endpoint.password
      || endpoint.hash || endpoint.search || !['', '/'].includes(endpoint.pathname)
      || !token || token.length < 16) throw new Error('RSS parser HTTPS endpoint (or opted-in loopback) and token are required');
  endpoint.pathname = path;
  for (const [key, value] of Object.entries(parameters)) endpoint.searchParams.set(key, value);
  const response = await fetchImpl(endpoint.toString(), {
    method: 'GET', redirect: 'error', headers: {'Authorization': 'Bearer ' + token},
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error('RSS parser unavailable');
  const advertised = Number(response.headers.get('content-length') || 0);
  if (advertised > 20_000) throw new Error('RSS parser response too large');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 20_000) throw new Error('RSS parser response too large');
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Never fetch user-provided feed URLs directly from an edge Worker. */
export async function fetchRssFromParser(env, rawUrl, fetchImpl = fetch) {
  if (!safeFeedUrl(rawUrl, parseFeedHosts(env))) throw new Error('RSS host is not allowlisted');
  const parsed = await fetchParserJson(env, '/rss', {url: rawUrl}, fetchImpl);
  if (!Array.isArray(parsed.items)) throw new Error('Malformed RSS parser response');
  return parsed.items.slice(0, 10);
}

/** External wiki/RDAP calls happen only at self-hosted parser's fixed endpoints;
 * translations run with locally installed language packs at that service.
 */
export async function lookupFromParser(env, kind, query, fetchImpl = fetch) {
  if (!['wiki', 'websearch', 'whois', 'translate'].includes(kind)
      || !query || query.length > 160) throw new Error('Invalid lookup');
  const parsed = await fetchParserJson(env, '/lookup', {kind, query}, fetchImpl);
  return typeof parsed.result === 'string' ? textLimit(parsed.result, 1500) : 'No result.';
}

export function smartFilename(raw, fallback = 'file') {
  const base = String(raw ?? '').normalize('NFKC')
    .replace(/[\\/\x00-\x1f:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 160);
  const result = base.replace(/\s+/g, '_').replace(/^[._]+|[._]+$/g, '');
  return result || fallback;
}

export function summarizeText(raw, maxLength = 300) {
  const input = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!input) return '';
  const sentences = input.match(/[^.!?]+[.!?]?/g) || [input];
  let summary = sentences.slice(0, 2).join(' ').trim();
  if (summary.length > maxLength) summary = summary.slice(0, maxLength - 1).trimEnd() + '…';
  return summary;
}

export function suggestTags(raw) {
  const s = String(raw ?? '').toLocaleLowerCase().replace(/[._]/g, ' ');
  const rules = [
    ['ssc', /\b(ssc|cgl|chsl|cpo)\b/],
    ['railway', /\b(rrb|ntpc|railway)\b/],
    ['maths', /\b(maths?|algebra|geometry|trigonometry|mensuration)\b/],
    ['english', /\b(english|grammar|vocabulary)\b/],
    ['reasoning', /\b(reasoning|puzzle|series)\b/],
    ['current-affairs', /\b(current affairs|news|gk|gs)\b/],
    ['video', /\b(mp4|mkv|video|movie)\b/],
    ['audio', /\b(mp3|audio|music|song)\b/],
    ['document', /\b(pdf|docx?|notes?|ebook|book)\b/],
  ];
  const tags = rules.filter(([, expression]) => expression.test(s)).map(([tag]) => tag);
  return tags.slice(0, 6);
}

export function searchIntent(raw) {
  const q = String(raw ?? '').trim().toLocaleLowerCase();
  const type = /\b(pdf|video|audio|document|photo|text)\b/.exec(q)?.[1] || null;
  const date = /\b(\d{4}-\d{2}-\d{2})\b/.exec(q)?.[1] || null;
  const query = q.replace(/\b(show|find|search|files?|about|for|from|the|all|my|archived|saved|on)\b/g, ' ')
    .replace(/\b(pdf|video|audio|document|photo|text)\b/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  return {type, date, query};
}

const normalizeTags = text => [...new Set(String(text || '').toLowerCase().split(/[\s,;]+/)
  .map(tag => tag.replace(/[^a-z0-9-]/g, '').slice(0, 32))
  .filter(tag => /^[a-z0-9][a-z0-9-]{1,31}$/.test(tag)))].slice(0, 8);

async function optionalInference(env, helpers, purpose, input) {
  if (!(await enabled(helpers, 'personal_ai'))) return null;
  try { return await runTextInference(env, purpose, input, helpers.aiFetch || fetch); }
  catch { return null; } // Never let an optional local model break owner commands.
}

/** Only explicit owner commands should be passed here by the entry point. */
export async function handlePersonalCommand(env, name, args, helpers) {
  const action = String(name || '').toLowerCase().split('@')[0];
  const raw = args.join(' ').trim();
  switch (action) {
    case '/alias': {
      const sub = args[0];
      if (sub === 'list') {
        const list = await helpers.rows('SELECT alias,phrase FROM personal_aliases ORDER BY alias LIMIT 20');
        return list.length ? list.map(item => '/' + item.alias + ' → ' + short(item.phrase, 80)).join('\n')
          : 'No aliases.';
      }
      const alias = args[1]?.toLowerCase();
      if (!/^[a-z][a-z0-9_]{1,23}$/.test(alias ?? '')) return 'Use /alias add NAME TEXT, /alias del NAME, or /alias list';
      if (sub === 'del') {
        await helpers.query('DELETE FROM personal_aliases WHERE alias=?', alias).run();
        return 'Alias removed: ' + alias;
      }
      const phrase = args.slice(2).join(' ').trim();
      if (sub !== 'add' || !phrase || phrase.length > 500 || phrase.startsWith('/')) {
        return 'Use /alias add NAME TEXT (max 500 chars, no command execution).';
      }
      await helpers.query('INSERT INTO personal_aliases(alias,phrase,created_at) VALUES(?,?,?) '
        + 'ON CONFLICT(alias) DO UPDATE SET phrase=excluded.phrase', alias, phrase, now(helpers)).run();
      return 'Alias saved. Use /shortcut ' + alias + '.';
    }
    case '/shortcut': {
      const alias = (args[0] || '').toLowerCase();
      const item = /^[a-z][a-z0-9_]{1,23}$/.test(alias)
        ? await helpers.query('SELECT phrase FROM personal_aliases WHERE alias=?', alias).first() : null;
      return item?.phrase || 'Alias not found.';
    }
    case '/autoreply': {
      if (args[0] === 'list') {
        const list = await helpers.rows('SELECT id,chat,keyword,enabled FROM personal_auto_replies ORDER BY id DESC LIMIT 20');
        return list.length ? list.map(r => '#' + r.id + ' ' + r.chat + ' ' + r.keyword + ' ' +
          (r.enabled ? 'ON' : 'OFF')).join('\n') : 'No auto-replies.';
      }
      if (args[0] === 'del' && id(args[1])) {
        await helpers.query('DELETE FROM personal_auto_replies WHERE id=?', id(args[1])).run();
        return 'Auto-reply removed.';
      }
      if (args[0] === 'add') {
        const values = partsByPipe(args.slice(1).join(' '), 2);
        const prefix = values?.[0].split(/\s+/);
        const [chat, ...keywordParts] = prefix || [];
        const keyword = keywordParts.join(' ').toLocaleLowerCase();
        const response = values?.[1];
        if (!isChat(chat) || keyword.length < 2 || keyword.length > 64 || !response || response.length > 300) {
          return 'Use /autoreply add -100CHAT KEYWORD | RESPONSE (2–64, max 300 chars).';
        }
        await helpers.query('INSERT INTO personal_auto_replies(chat,keyword,response) VALUES(?,?,?)',
          chat, keyword, response).run();
        return 'Auto-reply saved. Activate with /feature personal_auto_replies on.';
      }
      return 'Use /autoreply add -100CHAT KEYWORD | RESPONSE, /autoreply list, /autoreply del ID.';
    }
    case '/rss': {
      if (args[0] === 'list') {
        const list = await helpers.rows('SELECT id,url,dest_chat,dest_topic FROM personal_rss_feeds ORDER BY id DESC LIMIT 20');
        return list.length ? list.map(item => '#' + item.id + ' ' + short(item.url, 120)
          + ' → ' + item.dest_chat + '/' + item.dest_topic).join('\n') : 'No RSS feeds.';
      }
      if (args[0] === 'del' && id(args[1])) {
        await helpers.query('DELETE FROM personal_rss_items WHERE feed_id=?', id(args[1])).run();
        await helpers.query('DELETE FROM personal_rss_feeds WHERE id=?', id(args[1])).run();
        return 'Feed removed.';
      }
      if (args[0] === 'add' && args.length === 4) {
        const [, chat, topicRaw, url] = args;
        const topic = Number(topicRaw);
        if (!isChat(chat) || !/^\d+$/.test(topicRaw) || !Number.isSafeInteger(topic)
          || topic < 0 || topic > 2147483647 || !safeFeedUrl(url, parseFeedHosts(env))) {
          return 'Use /rss add -100DEST TOPIC HTTPS_URL from explicitly allowlisted ORBIT_RSS_HOSTS.';
        }
        await helpers.query('INSERT OR IGNORE INTO personal_rss_feeds(url,dest_chat,dest_topic) VALUES(?,?,?)',
          url, chat, topic).run();
        return 'RSS feed saved. RSS sending requires an enabled feature and trusted fetch service.';
      }
      return 'Use /rss add DEST TOPIC URL, /rss list, /rss del ID.';
    }
    case '/announce': {
      if (!(await enabled(helpers, 'personal_broadcasts'))) return 'Opt-in announcements are OFF.';
      const minutes = Number(args[0]);
      const body = args.slice(1).join(' ').trim();
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080 || !body || body.length > 512) {
        return 'Use /announce MINUTES MESSAGE (1–10080 minutes, max 512 chars).';
      }
      await helpers.query('INSERT INTO personal_announcements(body,due,created_at) VALUES(?,?,?)',
        body, now(helpers) + minutes * 60, now(helpers)).run();
      return 'Announcement queued for subscribed users only, maximum one send per tick.';
    }
    case '/subscribers': {
      const row = await helpers.query('SELECT count(*) AS n FROM personal_subscribers WHERE active=1').first();
      return 'Opted-in subscribers: ' + Number(row?.n || 0);
    }
    case '/afk': {
      const message = raw.slice(0, 200) || 'Away right now.';
      await helpers.query('INSERT INTO personal_afk(user_id,message,started_at) VALUES(?,?,?) '
        + 'ON CONFLICT(user_id) DO UPDATE SET message=excluded.message,started_at=excluded.started_at',
      String(helpers.ownerId), message, now(helpers)).run();
      return 'AFK enabled. Replies to you may get a throttled notice when personal_afk is ON.';
    }
    case '/back': {
      await helpers.query('DELETE FROM personal_afk WHERE user_id=?', String(helpers.ownerId)).run();
      return 'AFK disabled.';
    }
    case '/recipe': {
      if (args[0] === 'list') {
        const list = await helpers.rows('SELECT id,chat,keyword,enabled FROM personal_recipes ORDER BY id DESC LIMIT 20');
        return list.length ? list.map(r => '#' + r.id + ' ' + r.chat + ' ' + r.keyword +
          ' ' + (r.enabled ? 'ON' : 'OFF')).join('\n') : 'No recipes.';
      }
      if (args[0] === 'del' && id(args[1])) {
        await helpers.query('DELETE FROM personal_recipes WHERE id=?', id(args[1])).run();
        return 'Recipe removed.';
      }
      if (args[0] === 'add') {
        const values = partsByPipe(args.slice(1).join(' '), 2);
        const [chat, ...keywordParts] = values?.[0].split(/\s+/) || [];
        const keyword = keywordParts.join(' ').toLocaleLowerCase();
        const response = values?.[1];
        if (!isChat(chat) || keyword.length < 2 || keyword.length > 64 || !response || response.length > 300) {
          return 'Use /recipe add -100CHAT KEYWORD | RESPONSE. Only safe reply actions are supported.';
        }
        await helpers.query('INSERT INTO personal_recipes(chat,keyword,response) VALUES(?,?,?)',
          chat, keyword, response).run();
        return 'Recipe saved. Activate /feature personal_workflows on.';
      }
      return 'Use /recipe add -100CHAT KEYWORD | RESPONSE, /recipe list, /recipe del ID.';
    }
    case '/smartname': {
      if (!raw || raw.length > 2000) return 'Use /smartname TEXT (max 2000 chars).';
      const inferred = await optionalInference(env, helpers, 'filename', raw);
      return (inferred ? 'AI filename suggestion: ' : 'Offline filename suggestion: ')
        + smartFilename(inferred || raw);
    }
    case '/summarize': {
      if (!raw || raw.length > 2000) return 'Use /summarize TEXT (max 2000 chars).';
      const inferred = await optionalInference(env, helpers, 'summary', raw);
      return inferred ? 'AI summary: ' + textLimit(inferred, 500)
        : 'Offline extractive summary: ' + summarizeText(raw);
    }
    case '/tag': {
      const inferred = raw && raw.length <= 2000 ? await optionalInference(env, helpers, 'tags', raw) : null;
      const tags = normalizeTags(inferred || suggestTags(raw).join(','));
      return (inferred ? 'AI' : 'Offline') + ' suggested tags: ' + (tags.join(', ') || 'uncategorized');
    }
    case '/tagarchive': {
      const itemId = id(args[0]);
      const value = args.slice(1).join(' ').trim();
      if (!itemId || !value || value.length > 240) return 'Use /tagarchive ARCHIVE_ITEM_ID auto|tag1,tag2';
      const item = await helpers.query(
        'SELECT id,filename,caption_preview,media_kind FROM archive_items WHERE id=?', itemId).first();
      if (!item) return 'Archive item not found; use /library to locate metadata.';
      const auto = value === 'auto';
      const source = [item.filename || '', item.caption_preview || '', item.media_kind || ''].join(' ');
      const inferred = auto ? await optionalInference(env, helpers, 'tags', source) : null;
      const tags = normalizeTags(auto ? (inferred || suggestTags(source).join(',')) : value);
      if (!tags.length) return 'No valid tags. Use 2–32-character lowercase labels.';
      const origin = auto ? (inferred ? 'ai' : 'heuristic') : 'manual';
      for (const tag of tags) {
        await helpers.query('INSERT OR IGNORE INTO archive_tags(item_id,tag,origin,created_at) VALUES(?,?,?,?)',
          itemId, tag, origin, now(helpers)).run();
      }
      return 'Archive #' + itemId + ' tags saved: ' + tags.join(', ');
    }
    case '/tags': {
      const itemId = id(args[0]);
      if (!itemId) return 'Use /tags ARCHIVE_ITEM_ID';
      const tags = await helpers.rows('SELECT tag FROM archive_tags WHERE item_id=? ORDER BY tag LIMIT 20', itemId);
      return tags.length ? 'Archive #' + itemId + ': ' + tags.map(x => x.tag).join(', ') : 'No saved tags.';
    }
    case '/tagsearch': {
      const tag = normalizeTags(args[0] || '')[0];
      if (!tag || args.length !== 1) return 'Use /tagsearch TAG';
      const matches = await helpers.rows('SELECT a.id,a.filename,a.source,a.source_message_id FROM archive_tags t '
        + 'JOIN archive_items a ON a.id=t.item_id WHERE t.tag=? ORDER BY a.id DESC LIMIT 15', tag);
      return matches.length ? matches.map(a => '#' + a.id + ' ' + (a.filename || a.source + '/' + a.source_message_id)).join('\n')
        : 'No archive metadata has that tag.';
    }
    case '/tagremove': {
      const itemId = id(args[0]);
      const tag = normalizeTags(args[1] || '')[0];
      if (!itemId || !tag || args.length !== 2) return 'Use /tagremove ARCHIVE_ITEM_ID TAG';
      await helpers.query('DELETE FROM archive_tags WHERE item_id=? AND tag=?', itemId, tag).run();
      return 'Tag removed from archive metadata (if present).';
    }
    case '/searchnl': {
      if (!raw || raw.length > 120) return 'Use /searchnl YOUR ARCHIVE QUERY (max 120 chars).';
      const intent = searchIntent(raw);
      const clauses = [];
      const binds = [];
      if (intent.type) { clauses.push('media_kind=?'); binds.push(intent.type); }
      if (intent.query.length >= 2) {
        clauses.push("(filename LIKE ? ESCAPE '\\' OR caption_preview LIKE ? ESCAPE '\\')");
        const like = '%' + intent.query.replace(/[\\%_]/g, '\\$&') + '%';
        binds.push(like, like);
      }
      if (intent.date) {
        const start = Date.parse(intent.date + 'T00:00:00Z');
        if (Number.isFinite(start) && new Date(start).toISOString().slice(0, 10) === intent.date) {
          clauses.push('saved_at>=? AND saved_at<?'); binds.push(start / 1000, start / 1000 + 86400);
        }
      }
      if (!clauses.length) return 'Specify a media type, date, or filename keyword.';
      const list = await helpers.rows('SELECT media_kind,source,source_message_id,filename,dest_topic FROM archive_items WHERE '
        + clauses.join(' AND ') + ' ORDER BY id DESC LIMIT 10', ...binds);
      return list.length ? list.map(r => r.media_kind + ' ' + (r.filename || r.source + '/' + r.source_message_id)
        + ' topic ' + r.dest_topic).join('\n') : 'No matching indexed media.';
    }
    case '/menu': return 'Personal menu: /alias, /shortcut, /autoreply, /rss, /announce, /subscribers, '
      + '/afk, /back, /recipe, /smartname, /summarize, /tag, /tagarchive, /tags, /tagsearch, /tagremove, '
      + '/searchnl, /coin, /pick, '
      + '/prompt, /wiki, /websearch, /whois, /translate.';
    case '/prompt': {
      const fields = raw.split('|').map(x => x.trim());
      if (fields.length < 3 || fields.length > 13 || !fields.every(Boolean)
          || fields[0].length > 300 || fields.slice(1).some(x => x.length > 100)) {
        return 'Use /prompt QUESTION | OPTION 1 | OPTION 2 [| ... up to 12 options].';
      }
      // Telegram native poll renders interactive answer choices without bot
      // callback handlers, external services, or collecting voter identities.
      await helpers.telegram('sendPoll', {chat_id: helpers.ownerId, question: fields[0],
        options: fields.slice(1).map(text => ({text})), type: 'regular', is_anonymous: true,
        disable_notification: true});
      return 'Anonymous private poll created.';
    }
    case '/coin': return Math.random() >= 0.5 ? 'Heads' : 'Tails';
    case '/pick': {
      const options = raw.split('|').map(s => s.trim()).filter(Boolean).slice(0, 12);
      return options.length >= 2 && options.every(s => s.length <= 80)
        ? 'Picked: ' + options[Math.floor(Math.random() * options.length)]
        : 'Use /pick OPTION 1 | OPTION 2 [| OPTION 3...]';
    }
    case '/wiki': case '/websearch': case '/whois': case '/translate': {
      if (!raw || raw.length > 160) return 'Provide a short query (max 160 chars).';
      const lookup = typeof helpers.lookup === 'function' ? helpers.lookup
        : env.ORBIT_RSS_PARSER_URL && env.ORBIT_RSS_PARSER_TOKEN
          ? (kind, q) => lookupFromParser(env, kind, q) : null;
      if (!lookup) return 'External lookup provider not configured; no data was sent.';
      const kind = action.slice(1);
      const result = await lookup(kind, raw);
      return result ? textLimit(result, 1500) : 'No result.';
    }
    default: return null;
  }
}

export async function ingestPersonalUpdate(env, message, helpers) {
  if (!message?.chat || message.from?.is_bot || message.via_bot) return false;
  const chat = String(message.chat.id);
  const user = String(message.from?.id || '');
  const body = String(message.text || message.caption || '').trim();
  if (message.chat.type === 'private' && ['/subscribe', '/unsubscribe'].includes(body.split(/\s+/)[0])) {
    if (!(await enabled(helpers, 'personal_broadcasts'))) return false;
    if (!/^\d{1,16}$/.test(user)) return false;
    const optIn = body.split(/\s+/)[0] === '/subscribe';
    await helpers.query('INSERT INTO personal_subscribers(user_id,opted_in_at,active) VALUES(?,?,?) '
      + 'ON CONFLICT(user_id) DO UPDATE SET active=excluded.active', user, now(helpers), optIn ? 1 : 0).run();
    if (!optIn) {
      await helpers.query("UPDATE personal_announcement_targets SET state='cancelled' "
        + "WHERE user_id=? AND state='queued'", user).run();
    }
    await helpers.telegram('sendMessage', {chat_id: message.chat.id,
      text: optIn ? 'You have opted into announcements; send /unsubscribe any time.'
        : 'You are unsubscribed.'});
    return true;
  }
  if (!['group', 'supergroup'].includes(message.chat.type) || !body || !/^\d+$/.test(user)
      || user === String(helpers.ownerId) || message.has_protected_content) return false;
  const current = now(helpers);
  if (await enabled(helpers, 'personal_auto_replies')) {
    const list = await helpers.rows('SELECT * FROM personal_auto_replies WHERE chat=? AND enabled=1 ORDER BY id LIMIT 10', chat);
    for (const item of list) {
      if (!body.toLocaleLowerCase().includes(item.keyword) || Number(item.last_sent || 0) + 60 > current) continue;
      // Reserve the cooldown before sending to avoid multi-trigger bursts.
      const reserve = await helpers.query('UPDATE personal_auto_replies SET last_sent=? '
        + 'WHERE id=? AND last_sent<=?', current, item.id, current - 60).run();
      if ((reserve?.meta?.changes || 0) !== 1) continue;
      await helpers.telegram('sendMessage', {chat_id: message.chat.id,
        ...(message.message_thread_id ? {message_thread_id: message.message_thread_id} : {}),
        text: item.response});
      return true;
    }
  }
  if (await enabled(helpers, 'personal_workflows')) {
    const list = await helpers.rows('SELECT * FROM personal_recipes WHERE chat=? AND enabled=1 ORDER BY id LIMIT 10', chat);
    for (const item of list) {
      if (!body.toLocaleLowerCase().includes(item.keyword) || Number(item.last_sent || 0) + 60 > current) continue;
      const reserve = await helpers.query('UPDATE personal_recipes SET last_sent=? '
        + 'WHERE id=? AND last_sent<=?', current, item.id, current - 60).run();
      if ((reserve?.meta?.changes || 0) !== 1) continue;
      await helpers.telegram('sendMessage', {chat_id: message.chat.id,
        ...(message.message_thread_id ? {message_thread_id: message.message_thread_id} : {}),
        text: item.response});
      return true;
    }
  }
  if (await enabled(helpers, 'personal_afk')
      && String(message.reply_to_message?.from?.id) === String(helpers.ownerId)) {
    const afk = await helpers.query('SELECT message,started_at FROM personal_afk WHERE user_id=?',
      String(helpers.ownerId)).first();
    if (afk) {
      const seen = await helpers.query('SELECT sent_at FROM personal_afk_cooldowns WHERE chat_id=?', chat).first();
      if (Number(seen?.sent_at || 0) + 600 <= current) {
        await helpers.query('INSERT INTO personal_afk_cooldowns(chat_id,sent_at) VALUES(?,?) '
          + 'ON CONFLICT(chat_id) DO UPDATE SET sent_at=excluded.sent_at', chat, current).run();
        await helpers.telegram('sendMessage', {chat_id: message.chat.id,
          ...(message.message_thread_id ? {message_thread_id: message.message_thread_id} : {}),
          text: 'Owner is AFK: ' + afk.message});
        return true;
      }
    }
  }
  return false;
}

/** At most one RSS post and one announcement recipient per scheduled tick. */
export async function runPersonalScheduled(env, helpers) {
  let attempted = 0;
  const current = now(helpers);
  const fetchRss = typeof helpers.fetchRss === 'function' ? helpers.fetchRss
    : env.ORBIT_RSS_PARSER_URL && env.ORBIT_RSS_PARSER_TOKEN
      ? url => fetchRssFromParser(env, url) : null;
  if (await enabled(helpers, 'personal_rss') && fetchRss) {
    const feeds = await helpers.rows('SELECT * FROM personal_rss_feeds WHERE enabled=1 AND last_checked<=? '
      + 'ORDER BY last_checked,id LIMIT 1', current - 900);
    const feed = feeds[0];
    if (feed && safeFeedUrl(feed.url, parseFeedHosts(env))) {
      // Mark attempted before fetching: a crash cannot cause a tight retry loop.
      await helpers.query('UPDATE personal_rss_feeds SET last_checked=? WHERE id=?', current, feed.id).run();
      try {
      const items = await fetchRss(feed.url);
      const item = Array.isArray(items) ? items.slice(0, 1)[0] : null;
      if (item && typeof item.guid === 'string' && item.guid.length <= 500 && typeof item.title === 'string') {
        const duplicate = await helpers.query('SELECT 1 FROM personal_rss_items WHERE feed_id=? AND guid=?',
          feed.id, item.guid).first();
        if (!duplicate) {
          const title = textLimit(item.title, 250);
          let link = '';
          try {
            const parsed = new URL(item.url);
            if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) link = parsed.toString().slice(0, 500);
          } catch { /* ignore unsafe/non-URL link */ }
          // Reserve the GUID before sending. If transmission is ambiguous,
          // skip rather than automatically send a possible duplicate.
          await helpers.query('INSERT INTO personal_rss_items(feed_id,guid,sent_at) VALUES(?,?,?)',
            feed.id, item.guid, current).run();
          await helpers.telegram('sendMessage', {chat_id: feed.dest_chat,
            ...(feed.dest_topic ? {message_thread_id: feed.dest_topic} : {}),
            text: short(title + (link ? '\n' + link : ''), 750), disable_notification: true});
          attempted++;
        }
      }
      } catch {
        // Keep RSS crashes or uncertain sends from stalling opt-in broadcasts;
        // GUID reservation above makes unknown delivery outcomes non-retryable.
        await helpers.audit?.('personal_rss_failed', null, null, 'RSS feed #' + feed.id);
      }
    }
  }
  if (await enabled(helpers, 'personal_broadcasts')) {
    const jobs = await helpers.rows("SELECT * FROM personal_announcements WHERE state IN ('queued','sending') "
      + 'AND due<=? ORDER BY id LIMIT 1', current);
    const job = jobs[0];
    if (job) {
      if (job.state === 'queued') {
        const subscribers = await helpers.rows('SELECT user_id FROM personal_subscribers '
          + 'WHERE active=1 ORDER BY user_id LIMIT 50');
        for (const subscriber of subscribers) {
          await helpers.query('INSERT OR IGNORE INTO personal_announcement_targets(announcement_id,user_id) VALUES(?,?)',
            job.id, subscriber.user_id).run();
        }
        await helpers.query("UPDATE personal_announcements SET state='sending' WHERE id=? AND state='queued'", job.id).run();
      }
      const target = await helpers.query("UPDATE personal_announcement_targets SET state='sending',attempted_at=? "
        + "WHERE announcement_id=? AND user_id=(SELECT user_id FROM personal_announcement_targets "
        + "WHERE announcement_id=? AND state='queued' ORDER BY user_id LIMIT 1) RETURNING user_id",
      current, job.id, job.id).first();
      if (target) {
        const subscribed = await helpers.query('SELECT active FROM personal_subscribers WHERE user_id=?',
          target.user_id).first();
        if (!subscribed?.active) {
          await helpers.query("UPDATE personal_announcement_targets SET state='cancelled' "
            + "WHERE announcement_id=? AND user_id=?", job.id, target.user_id).run();
          return attempted;
        }
        try {
          await helpers.telegram('sendMessage', {chat_id: target.user_id, text: job.body,
            disable_notification: true});
          await helpers.query("UPDATE personal_announcement_targets SET state='done' WHERE announcement_id=? AND user_id=?",
            job.id, target.user_id).run();
        } catch {
          await helpers.query("UPDATE personal_announcement_targets SET state='uncertain' WHERE announcement_id=? AND user_id=?",
            job.id, target.user_id).run();
        }
        attempted++;
      } else {
        await helpers.query("UPDATE personal_announcements SET state='done' WHERE id=? AND state='sending'", job.id).run();
      }
    }
  }
  return attempted;
}
