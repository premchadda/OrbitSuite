import {
  eligible, parseRouteArgs, introducesCycle, deliveryCall,
  validPositiveId, validChat, validTopic, parseMessageLink,
  safeMediaUrl, classifyError, safeReply, MAX_BATCH, fileMetadata, parseTelegramUserId,
} from './core.js';
import {
  handlePersonalCommand, ingestPersonalUpdate, runPersonalScheduled,
} from './personal_extensions.js';
import {
  handleMessagingCommand, ingestMessagingUpdate, runMessagingScheduled,
  matchesExtendedFilters, propagateEditedMessage, syncTopicTitle,
} from './messaging_extensions.js';
import {
  handleAdminCommand, handleAdminUpdate, handleAdminHttp,
  checkRequiredMembership, checkAdminRole, checkAndConsumeQuota, runAdminScheduled,
} from './admin_extensions.js';
import {buildTopicChooser, applyTopicChoice} from './topic_chooser.js';
import {recordOwnerPart, queueOwnerJoin} from './media_join.js';
import {handleMiniHttp, miniAppUrl} from './mini_app.js';
import {formCommand, formCallback, formAnswer} from './owner_forms.js';

const now = () => Math.floor(Date.now() / 1000);
const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const success = () => new Response('OK');
const MAX_QUEUED = 1500;
const MAX_MANUAL_QUEUED = 100;
const MAX_MEDIA_QUEUED = 50;
const MEDIA_ALLOWED_OPTIONS = new Set([
  'playlist_limit','caption','filename','replacements','trim_start','trim_duration',
  'crop','rotate','height','compress_crf','thumbnail_at','thumbnail','subtitles','embed_subtitles',
  'watermark','split','ffprobe','screenshot_at','embed_metadata','max_bytes',
  'audio_format','audio_bitrate','video_codec','container',
]);
const ALLOWED_FEATURES = new Set([
  'archive','manual_save','media_downloads','user_bridge','group_admin','rss','reminders',
  'personal_auto_replies','personal_rss','personal_broadcasts','personal_workflows','personal_afk',
  'personal_ai','personal_transcription',
]);
const DAILY_SEND_CAP = 200; // deliberately conservative for personal use

async function telegram(env, method, body) {
  const response = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error('Telegram API request failed');
    error.code = data.error_code || response.status;
    error.retry = data.parameters?.retry_after;
    throw error;
  }
  return data.result;
}

async function setSetting(env, key, value) {
  await query(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value)).run();
}
async function setting(env, key) {
  return (await query(env, 'SELECT value FROM settings WHERE key=?', key).first())?.value;
}
async function audit(env, action, routeId = null, jobId = null, detail = '') {
  await query(env, 'INSERT INTO audit_events(at,action,route_id,job_id,detail) VALUES(?,?,?,?,?)',
    now(), action, routeId, jobId, detail.slice(0, 120)).run();
}
async function rows(env, sql, ...args) {
  return (await query(env, sql, ...args).all()).results || [];
}
async function featureEnabled(env, name) {
  return Number((await query(env, 'SELECT enabled FROM feature_flags WHERE feature=?', name).first())?.enabled || 0) === 1;
}
const numberArg = raw => /^\d+$/.test(raw ?? '') ? Number(raw) : NaN;

function extensionHelpers(env) {
  return {
    query: (sql, ...args) => query(env, sql, ...args),
    rows: (sql, ...args) => rows(env, sql, ...args),
    telegram: (method, body) => telegram(env, method, body),
    audit: (action, routeId = null, jobId = null, detail = '') =>
      audit(env, action, routeId, jobId, detail),
    featureEnabled: name => featureEnabled(env, name),
    setting: key => setting(env, key),
    setSetting: (key, value) => setSetting(env, key, value),
    now, ownerId: env.OWNER_ID,
  };
}

async function command(env, message) {
  const [raw, ...args] = (message.text || '').trim().split(/\s+/);
  const name = raw?.split('@')[0].toLowerCase();
  let reply = 'Unknown command. See /help';
  let replyMarkup = null;
  switch (name) {
    case '/start': case '/help':
      reply = [
        'OrbitSuite • private owner-only Bot API relay',
        '/route SOURCE SOURCE_TOPIC DEST DEST_TOPIC [all|pdf|document|video|photo|audio|voice|animation|sticker] [copy|forward]',
        '/archive SOURCE SOURCE_TOPIC DEST DEST_TOPIC (all-copy route)',
        '/setarchive DEST_CHAT [TOPIC] /archiveinfo /save TELEGRAM_MESSAGE_LINK /savejobs',
        '/features /feature FEATURE on|off',
        '/remind MINUTES TEXT /reminders /cancelreminder ID',
        '/caption ROUTE TEXT or /caption ROUTE clear (static media caption)',
        'In a group: /id, or (when enabled) reply with /pin /unpin /delete',
        'Group admin (opt-in): reply /ban /mute MINUTES /promote; /unban ID /unmute ID /demote ID',
        '/dl HTTPS_URL /adl HTTPS_URL /dlq 360|480|720|1080 HTTPS_URL',
        '/adlq 0|2|5|7 HTTPS_URL /mediajobs /mediacancel ID',
        '/mediabatch video|audio HTTPS_URL [more URLs, up to 10] /mediaoptions JOB_ID JSON',
        '/joinparts COUNT (replying/sending 2–10 Telegram .partNNN documents to owner bot first)',
        '/transcribe (reply in your private bot chat to an audio/voice file; optional local Whisper)',
        '/mediareconcile ID /mediaretry ID CONFIRM /mediaskip ID',
        '/savecancel ID /savereconcile ID /saveretry ID CONFIRM /saveskip ID',
        '/routes /topics /disable ID /enable ID /delroute ID',
        '/checkroute ID (verify bot access before enabling traffic)',
        '/filter ROUTE include|exclude KEYWORD ; /filter ROUTE clear',
        '/sender ROUTE USER_ID|clear /filesize ROUTE MIN_BYTES MAX_BYTES|clear',
        '/batch ROUTE FIRST LAST (max 50 known IDs) /copyone ROUTE MESSAGE_ID',
        '/batchlinks ROUTE FIRST_LINK LAST_LINK (up to 50 known IDs)',
        '/topiccreate DEST_CHAT TOPIC_NAME (requires group admin rights)',
        '/library /find SEARCH_TERM /files type|source|topic|date|name VALUE (metadata only)',
        '/jobs /stats /status /cancel JOB /resume JOB /skip JOB /retry JOB CONFIRM',
        '/reconcile JOB (mark stuck sending job as uncertain after 5 min)',
        '/stop /run /note TEXT /notes',
        'Personal plugins: /menu /alias /autoreply /rss /announce /afk /recipe /smartname /summarize /tag /searchnl',
        'Opt-in model: /feature personal_ai on; archive metadata: /tagarchive /tags /tagsearch /tagremove',
        'Routing plugins: /autotopics /topicsync /topicmaps /editsync /mirrorremove /routepattern /routefile',
        '/routedates /routewindow /routebatch /routebatches /routebatchpause /routebatchresume /routetemplate',
        '/topicchoose ROUTE_ID source|dest (private inline topic picker)',
        '/mini (owner-only Telegram Mini App; requires HTTPS public URL and dashboard enabled)',
        '/formnew TITLE | QUESTION | QUESTION; /formlist /formopen ID /formresults ID /formcancel',
        'Admin plugins: /adminhelp /adminfeatures /adminfeature /adminstats /modchat /modterm /modrate',
        'Bot must belong to both chats. Source must be authorized and unprotected.',
        'TOPIC 0 = any source thread / default destination thread.',
        'In an authorized group topic, send /id to see its chat and topic IDs.',
        'Telegram-to-Telegram delivery; no server file downloads.',
      ].join('\n');
      break;
    case '/route': case '/archive': {
      const parts = name === '/archive' ? [...args.slice(0, 4), 'all', 'copy'] : args;
      const proposed = parseRouteArgs(parts);
      if (!proposed) {
        reply = 'Invalid route. Use -100... chat IDs, nonnegative topic IDs, and different chats.';
        break;
      }
      const existing = await rows(env, 'SELECT source,dest FROM routes');
      if (introducesCycle(existing, proposed)) {
        reply = 'Rejected: would create a forwarding loop.';
        break;
      }
      const duplicate = await query(env, 'SELECT * FROM routes WHERE source=? AND topic=? AND dest=? AND dest_topic=?',
        proposed.source, proposed.topic, proposed.dest, proposed.dest_topic).first();
      if (duplicate) {
        reply = duplicate.kind === proposed.kind && duplicate.mode === proposed.mode
          ? 'That route already exists as #' + duplicate.id
          : 'Route #' + duplicate.id + ' already exists with different settings. Delete it and recreate.';
        break;
      }
      if (existing.length >= 100) { reply = '100-route limit reached.'; break; }
      await query(env, 'INSERT OR IGNORE INTO routes(source,topic,dest,dest_topic,kind,mode) VALUES(?,?,?,?,?,?)',
        proposed.source, proposed.topic, proposed.dest, proposed.dest_topic, proposed.kind, proposed.mode).run();
      const record = await query(env, 'SELECT id FROM routes WHERE source=? AND topic=? AND dest=? AND dest_topic=?',
        proposed.source, proposed.topic, proposed.dest, proposed.dest_topic).first();
      await audit(env, 'route_saved', record?.id);
      reply = 'Route #' + record?.id + ' saved. Check bot permissions in both chats.';
      break;
    }
    case '/routes': {
      const rr = await rows(env, 'SELECT * FROM routes ORDER BY id LIMIT 30');
      reply = rr.length ? rr.map(r => '#' + r.id + ' ' + r.source + '/' + r.topic + ' → ' + r.dest +
        '/' + r.dest_topic + ' ' + r.kind + ' ' + r.mode + ' ' + (r.enabled ? 'ON' : 'OFF')).join('\n') : 'No routes.';
      break;
    }
    case '/checkroute': {
      const id = numberArg(args[0]);
      const route = validPositiveId(id) ? await query(env, 'SELECT * FROM routes WHERE id=?', id).first() : null;
      if (!route) { reply = 'Route not found. Use /routes.'; break; }
      const me = await telegram(env, 'getMe', {});
      const summary = [];
      for (const [label, chat] of [['Source', route.source], ['Destination', route.dest]]) {
        try {
          const membership = await telegram(env, 'getChatMember', {chat_id: chat, user_id: me.id});
          summary.push(label + ': ' + (membership.status || 'unknown'));
        } catch (error) {
          summary.push(label + ': inaccessible (API ' + (Number(error.code) || 'transport') + ')');
        }
      }
      reply = 'Route #' + id + ' Bot API access check:\n' + summary.join('\n') +
        '\nThis does not guarantee permission to copy specific messages or post to every topic.';
      break;
    }
    case '/topics': {
      const tt = await rows(env, 'SELECT chat,thread,title FROM topics ORDER BY chat,thread LIMIT 30');
      reply = tt.length ? tt.map(t => t.chat + ' thread ' + t.thread + (t.title ? ' (' + t.title + ')' : '')).join('\n')
        : 'No observed topics. Send an authorized message in a routed source group.';
      break;
    }
    case '/topicchoose': {
      const picker = await buildTopicChooser(env, args);
      reply = picker.text;
      replyMarkup = picker.reply_markup || null;
      break;
    }
    case '/topiccreate': {
      const destination = args[0];
      const title = args.slice(1).join(' ').trim();
      if (!validChat(destination) || !title || title.length > 128) {
        reply = 'Usage: /topiccreate -100DEST_CHAT TOPIC_NAME (1-128 chars)';
        break;
      }
      try {
        const created = await telegram(env, 'createForumTopic', {chat_id: destination, name: title});
        if (!validPositiveId(created?.message_thread_id)) throw new Error('Invalid topic ID');
        await query(env, 'INSERT OR REPLACE INTO topics(chat,thread,title) VALUES(?,?,?)',
          destination, created.message_thread_id, title).run();
        await audit(env, 'topic_created');
        reply = 'Created topic ' + created.message_thread_id + ' in ' + destination + '. Use it in /route.';
      } catch (error) {
        reply = 'Topic creation failed. Check forum and bot administrator permissions (API ' +
          (Number(error.code) || 'transport') + ').';
      }
      break;
    }
    case '/library': {
      const items = await rows(env, 'SELECT source,source_message_id,dest,dest_topic,media_kind,filename,saved_at ' +
        'FROM archive_items ORDER BY id DESC LIMIT 15');
      reply = items.length ? items.map(item => item.media_kind + ' ' +
        (item.filename || item.source + '/' + item.source_message_id) + ' → ' +
        item.dest + '/' + item.dest_topic).join('\n') : 'Archive index is empty.';
      break;
    }
    case '/find': {
      const term = args.join(' ').trim();
      if (term.length < 2 || term.length > 80) {
        reply = 'Usage: /find SEARCH_TERM (2-80 characters)';
        break;
      }
      const literal = term.replace(/[\\%_]/g, '\\$&');
      const items = await rows(env, 'SELECT source,source_message_id,dest,dest_topic,media_kind,filename ' +
        'FROM archive_items WHERE filename LIKE ? ESCAPE \'\\\' OR caption_preview LIKE ? ESCAPE \'\\\' ' +
        'OR source LIKE ? ESCAPE \'\\\' OR media_kind LIKE ? ESCAPE \'\\\' ' +
        'ORDER BY id DESC LIMIT 15', ...Array(4).fill('%' + literal + '%'));
      reply = items.length ? items.map(item => item.media_kind + ' ' +
        (item.filename || item.source + '/' + item.source_message_id) + ' → ' +
        item.dest + '/' + item.dest_topic).join('\n') : 'No matching archived metadata.';
      break;
    }
    case '/files': {
      const [selector, ...values] = args;
      let clause = '';
      let binds = [];
      if (selector === 'type' && values.length === 1
          && ['pdf','document','video','photo','audio','voice','animation','sticker','text','unknown'].includes(values[0])) {
        clause = 'media_kind=?';
        binds = [values[0]];
      } else if (selector === 'source' && values.length === 1 && validChat(values[0])) {
        clause = 'source=?';
        binds = [values[0]];
      } else if (selector === 'topic' && values.length === 2 && validChat(values[0])
          && /^\d+$/.test(values[1]) && validTopic(Number(values[1]))) {
        clause = 'dest=? AND dest_topic=?';
        binds = [values[0], Number(values[1])];
      } else if (selector === 'date' && values.length === 1
          && /^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
        const date = new Date(values[0] + 'T00:00:00Z');
        if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== values[0]) {
          reply = 'Invalid UTC date. Use YYYY-MM-DD.';
          break;
        }
        clause = 'saved_at>=? AND saved_at<?';
        binds = [Math.floor(date.getTime() / 1000), Math.floor(date.getTime() / 1000) + 86400];
      } else if (selector === 'name' && values.length >= 1) {
        const term = values.join(' ');
        if (term.length < 2 || term.length > 80) { reply = 'Filename query must be 2–80 characters.'; break; }
        clause = "filename LIKE ? ESCAPE '\\'";
        binds = ['%' + term.replace(/[\\%_]/g, '\\$&') + '%'];
      } else {
        reply = 'Usage: /files type pdf | source -100CHAT | topic -100DEST THREAD | date YYYY-MM-DD | name WORD';
        break;
      }
      const items = await rows(env, 'SELECT source,source_message_id,dest,dest_topic,media_kind,filename ' +
        'FROM archive_items WHERE ' + clause + ' ORDER BY id DESC LIMIT 15', ...binds);
      reply = items.length ? items.map(item => item.media_kind + ' ' +
        (item.filename || item.source + '/' + item.source_message_id) + ' → ' +
        item.dest + '/' + item.dest_topic).join('\n') : 'No archived files match that filter.';
      break;
    }
    case '/setarchive': {
      const dest = args[0];
      const topic = args.length > 1 ? numberArg(args[1]) : 0;
      if (!validChat(dest) || !validTopic(topic)) {
        reply = 'Usage: /setarchive -100DESTINATION_CHAT_ID [TOPIC_ID]';
        break;
      }
      await setSetting(env, 'archive_dest', dest);
      await setSetting(env, 'archive_topic', topic);
      await audit(env, 'archive_configured');
      reply = 'Archive destination set to ' + dest + ' topic ' + topic +
        '. The bot must have permission to post there.';
      break;
    }
    case '/archiveinfo': {
      reply = 'Manual archive: ' + (await setting(env, 'archive_dest') || 'NOT CONFIGURED') +
        ', topic ' + (await setting(env, 'archive_topic') || 0);
      break;
    }
    case '/save': {
      if (!(await featureEnabled(env, 'manual_save'))) { reply = 'Manual saves are disabled. Use /feature manual_save on.'; break; }
      const link = parseMessageLink(args[0]);
      const dest = await setting(env, 'archive_dest');
      const topic = Number(await setting(env, 'archive_topic') || 0);
      if (!link) { reply = 'Use /save https://t.me/CHANNEL/MESSAGE_ID or /save https://t.me/c/CHAT/MESSAGE_ID'; break; }
      if (!validChat(dest) || !validTopic(topic)) { reply = 'Configure /setarchive first.'; break; }
      if (link.source === dest) { reply = 'Source and archive destination must differ.'; break; }
      if (await setting(env, 'stopped') === '1') { reply = 'Emergency stop is enabled. Use /run first.'; break; }
      const outstanding = (await query(env, "SELECT count(*) AS n FROM manual_jobs WHERE state IN ('queued','sending','uncertain')").first()).n;
      if (outstanding >= MAX_MANUAL_QUEUED) { reply = 'Manual archive queue is full; resolve jobs first.'; break; }
      await query(env, 'INSERT OR IGNORE INTO manual_jobs(source,dest,dest_topic,message_id) VALUES(?,?,?,?)',
        link.source, dest, topic, link.messageId).run();
      const saved = await query(env, 'SELECT id,state FROM manual_jobs WHERE source=? AND dest=? AND dest_topic=? AND message_id=?',
        link.source, dest, topic, link.messageId).first();
      await audit(env, 'save_queued', null, saved?.id, 'manual');
      reply = 'Manual save #' + saved?.id + ': ' + saved?.state +
        '. Telegram must grant the bot access to that unprotected message.';
      break;
    }
    case '/savejobs': {
      const ss = await rows(env, 'SELECT id,source,message_id,state,error FROM manual_jobs ORDER BY id DESC LIMIT 20');
      reply = ss.length ? ss.map(s => 'M#' + s.id + ' ' + s.source + '/' + s.message_id + ' ' +
        s.state + (s.error ? ' (' + s.error + ')' : '')).join('\n') : 'No manual saves.';
      break;
    }
    case '/features': {
      const ff = await rows(env, 'SELECT feature,enabled FROM feature_flags ORDER BY feature');
      reply = ff.map(f => f.feature + ': ' + (f.enabled ? 'ON' : 'OFF')).join('\n') ||
        'No features configured. Apply migrations.';
      break;
    }
    case '/mini': {
      const url = miniAppUrl(env.ORBIT_PUBLIC_URL);
      const enabled = (await query(env,
        'SELECT enabled FROM admin_feature_flags WHERE name=?', 'dashboard').first())?.enabled;
      if (!enabled || !url) {
        reply = 'Mini App is OFF. Configure an HTTPS ORBIT_PUBLIC_URL and /adminfeature dashboard on.';
        break;
      }
      reply = 'Owner dashboard: Telegram validates your identity before returning read-only data.';
      replyMarkup = {inline_keyboard: [[{text: 'Open OrbitSuite Mini App', web_app: {url}}]]};
      break;
    }
    case '/feature': {
      const [feature, mode] = args;
      if (!ALLOWED_FEATURES.has(feature) || !['on','off'].includes(mode)) {
        reply = 'Usage: /feature FEATURE on|off; see /features (includes optional personal modules)';
        break;
      }
      if (mode === 'on' && ['rss','user_bridge'].includes(feature)) {
        reply = feature + ' is managed by an optional external service; this Worker switch is reserved.';
        break;
      }
      await query(env, 'UPDATE feature_flags SET enabled=? WHERE feature=?', mode === 'on' ? 1 : 0, feature).run();
      await audit(env, 'feature_changed', null, null, feature + ':' + mode);
      reply = feature + ' ' + mode.toUpperCase() + '. Some optional services require a separate process.';
      break;
    }
    case '/remind': {
      if (!(await featureEnabled(env, 'reminders'))) { reply = 'Reminders OFF. Use /feature reminders on.'; break; }
      const minutes = numberArg(args[0]);
      const body = args.slice(1).join(' ').trim();
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 43200 || !body || body.length > 1000) {
        reply = 'Usage: /remind MINUTES TEXT (1 minute to 30 days; max 1000 chars)';
        break;
      }
      const result = await query(env, 'INSERT INTO reminders(body,due,created_at) VALUES(?,?,?) RETURNING id',
        body, now() + minutes * 60, now()).first();
      reply = 'Reminder #' + result?.id + ' scheduled.';
      break;
    }
    case '/reminders': {
      const rs = await rows(env, 'SELECT id,due,state,body FROM reminders ORDER BY id DESC LIMIT 15');
      reply = rs.length ? rs.map(r => '#' + r.id + ' ' + r.state + ' due ' +
        new Date(r.due * 1000).toISOString().slice(0, 16) + ' ' + r.body.slice(0, 80)).join('\n') : 'No reminders.';
      break;
    }
    case '/cancelreminder': {
      const id = numberArg(args[0]);
      if (!validPositiveId(id)) { reply = 'Provide a reminder ID.'; break; }
      await query(env, "UPDATE reminders SET state='cancelled' WHERE id=? AND state='queued'", id).run();
      reply = 'Reminder cancellation processed.';
      break;
    }
    case '/dl': case '/adl': case '/dlq': case '/adlq': {
      if (!(await featureEnabled(env, 'media_downloads'))) {
        reply = 'Media downloads are OFF. Start a trusted media worker, then /feature media_downloads on.';
        break;
      }
      const selected = name === '/dlq' || name === '/adlq' ? args[0] : null;
      const url = selected !== null ? args[1] : args[0];
      const dest = await setting(env, 'archive_dest');
      const topic = Number(await setting(env, 'archive_topic') || 0);
      const video = name === '/dl' || name === '/dlq';
      const allowed = video ? new Set(['360', '480', '720', '1080'])
        : new Set(['0', '2', '5', '7']);
      if (!safeMediaUrl(url) || args.length !== (selected === null ? 1 : 2)
          || (selected !== null && !allowed.has(selected))) {
        reply = 'Use /dl URL, /adl URL, /dlq 360|480|720|1080 URL, or /adlq 0|2|5|7 URL';
        break;
      }
      if (!validChat(dest) || !validTopic(topic)) { reply = 'Configure /setarchive first.'; break; }
      const count = (await query(env, "SELECT count(*) AS n FROM media_jobs WHERE state IN ('queued','running','uncertain')").first()).n;
      if (count >= MAX_MEDIA_QUEUED) { reply = 'Media worker queue is full.'; break; }
      const kind = video ? 'video' : 'audio';
      const result = await query(env, 'INSERT INTO media_jobs(url,kind,dest,dest_topic,created_at,quality) VALUES(?,?,?,?,?,?) RETURNING id',
        url, kind, dest, topic, now(), selected).first();
      await audit(env, 'media_queued', null, result?.id, kind);
      reply = 'Media job #' + result?.id + ' queued. The optional Python service must be running.';
      break;
    }
    case '/mediabatch': {
      if (!(await featureEnabled(env, 'media_downloads'))) {
        reply = 'Media downloads are OFF. Start the trusted media worker and enable them explicitly.';
        break;
      }
      const [kind, ...urls] = args;
      if (!['audio', 'video'].includes(kind) || urls.length < 2 || urls.length > 10
          || !urls.every(safeMediaUrl)) {
        reply = 'Usage: /mediabatch video|audio HTTPS_URL HTTPS_URL ... (2–10 permitted URLs)';
        break;
      }
      const dest = await setting(env, 'archive_dest');
      const topic = Number(await setting(env, 'archive_topic') || 0);
      if (!validChat(dest) || !validTopic(topic)) { reply = 'Configure /setarchive first.'; break; }
      const count = (await query(env,
        "SELECT count(*) AS n FROM media_jobs WHERE state IN ('queued','running','uncertain')").first()).n;
      if (count >= MAX_MEDIA_QUEUED) { reply = 'Media worker queue is full.'; break; }
      const result = await query(env,
        'INSERT INTO media_jobs(url,kind,dest,dest_topic,created_at,urls_json) VALUES(?,?,?,?,?,?) RETURNING id',
        urls[0], kind, dest, topic, now(), JSON.stringify(urls)).first();
      await audit(env, 'media_batch_queued', null, result?.id, kind);
      reply = 'Batch media job #' + result?.id + ' queued with ' + urls.length + ' URLs.';
      break;
    }
    case '/joinparts': {
      reply = await queueOwnerJoin(env, args, extensionHelpers(env));
      break;
    }
    case '/transcribe': {
      if (!(await featureEnabled(env, 'personal_transcription'))
          || !(await featureEnabled(env, 'media_downloads'))) {
        reply = 'Local transcription is OFF. Start the trusted media worker and enable '
          + '/feature media_downloads on and /feature personal_transcription on.';
        break;
      }
      const original = message.reply_to_message;
      const attachment = original?.voice || original?.audio
        || (String(original?.document?.mime_type || '').startsWith('audio/') ? original.document : null);
      const fileId = String(attachment?.file_id || '');
      const size = Number(attachment?.file_size || 0);
      if (original?.has_protected_content || !/^[A-Za-z0-9_-]{16,512}$/.test(fileId)
          || !Number.isSafeInteger(size) || size < 1 || size > 200 * 1024 * 1024) {
        reply = 'Reply to an accessible voice/audio file (up to 200 MiB; public Bot API downloads are smaller).';
        break;
      }
      const pending = await query(env,
        "SELECT count(*) AS n FROM media_jobs WHERE state IN ('queued','running','uncertain')").first();
      if (pending.n >= MAX_MEDIA_QUEUED) { reply = 'Media worker queue is full.'; break; }
      const job = await query(env,
        'INSERT INTO media_jobs(url,kind,dest,dest_topic,created_at,task,file_id) '
        + 'VALUES(?,?,?,?,?,?,?) RETURNING id',
        'telegram-audio://owner', 'audio', String(env.OWNER_ID), 0, now(), 'transcribe', fileId).first();
      await audit(env, 'transcription_queued', null, job?.id, 'owner_audio');
      reply = 'Transcription job #' + job?.id + ' queued for the optional locally installed Whisper model.';
      break;
    }
    case '/mediaoptions': {
      const id = numberArg(args[0]);
      const raw = args.slice(1).join(' ');
      let options = null;
      try { options = JSON.parse(raw); } catch { /* Show usage without accepting untrusted JSON. */ }
      if (!validPositiveId(id) || !options || Array.isArray(options) || typeof options !== 'object'
          || raw.length > 2400 || Object.keys(options).length > 20
          || Object.keys(options).some(key => !MEDIA_ALLOWED_OPTIONS.has(key))) {
        reply = 'Usage: /mediaoptions QUEUED_JOB_ID {"height":720,"thumbnail":true} ' +
          '(JSON options must use supported media-worker keys)';
        break;
      }
      const updated = await query(env,
        "UPDATE media_jobs SET options_json=? WHERE id=? AND state='queued'",
        JSON.stringify(options), id).run();
      reply = updated.meta?.changes ? 'Media options saved for queued job #' + id +
        '. The isolated worker validates values before processing.' : 'Job not found or already started.';
      break;
    }
    case '/mediajobs': {
      const jobs = await rows(env, 'SELECT id,kind,state,error,progress_stage,progress_bytes,' +
        'progress_total_bytes,progress_done,progress_items_total FROM media_jobs ORDER BY id DESC LIMIT 20');
      reply = jobs.length ? jobs.map(j => 'Media #' + j.id + ' ' + j.kind + ' ' + j.state +
        (j.progress_stage ? ' [' + j.progress_stage +
          (j.progress_total_bytes ? ' ' + Math.min(100, Math.round(100 * j.progress_bytes / j.progress_total_bytes)) + '%'
            : j.progress_items_total ? ' ' + j.progress_done + '/' + j.progress_items_total : '') + ']' : '') +
        (j.error ? ' (' + j.error + ')' : '')).join('\n') : 'No media jobs.';
      break;
    }
    case '/mediacancel': case '/mediareconcile': case '/mediaretry': case '/mediaskip': {
      const id = numberArg(args[0]);
      if (!validPositiveId(id)) { reply = 'Provide a valid media job ID.'; break; }
      if (name === '/mediaretry' && args[1] !== 'CONFIRM') {
        reply = 'Check destination first; /mediaretry ID CONFIRM could duplicate a successful upload.';
        break;
      }
      const sql = {
        '/mediacancel': "UPDATE media_jobs SET state='cancelled' WHERE id=? AND state='queued'",
        '/mediareconcile': "UPDATE media_jobs SET state='uncertain',error='worker interrupted; inspect destination' WHERE id=? AND state='running' AND claimed_at<?",
        '/mediaretry': "UPDATE media_jobs SET state='queued',error=NULL,due=0 WHERE id=? AND state IN ('uncertain','failed')",
        '/mediaskip': "UPDATE media_jobs SET state='skipped' WHERE id=? AND state IN ('uncertain','failed')",
      }[name];
      await query(env, sql, ...(name === '/mediareconcile' ? [id, now() - 3600] : [id])).run();
      await audit(env, name.slice(1), null, id, 'media');
      reply = 'Media job command processed. Check /mediajobs.';
      break;
    }
    case '/savecancel': case '/savereconcile': case '/saveretry': case '/saveskip': {
      const id = numberArg(args[0]);
      if (!validPositiveId(id)) { reply = 'Provide a valid manual save job ID.'; break; }
      if (name === '/saveretry' && args[1] !== 'CONFIRM') {
        reply = 'Check destination first; /saveretry ID CONFIRM may duplicate a successful send.';
        break;
      }
      const sql = {
        '/savecancel': "UPDATE manual_jobs SET state='cancelled' WHERE id=? AND state='queued'",
        '/savereconcile': "UPDATE manual_jobs SET state='uncertain',error='send interrupted; check destination' WHERE id=? AND state='sending' AND claimed_at<?",
        '/saveretry': "UPDATE manual_jobs SET state='queued',error=NULL,due=0 WHERE id=? AND state='uncertain'",
        '/saveskip': "UPDATE manual_jobs SET state='skipped' WHERE id=? AND state IN ('failed','uncertain')",
      }[name];
      await query(env, sql, ...(name === '/savereconcile' ? [id, now() - 300] : [id])).run();
      await audit(env, name.slice(1), null, id, 'manual');
      reply = 'Manual save command processed. Check /savejobs.';
      break;
    }
    case '/filter': {
      const id = numberArg(args[0]);
      const field = args[1];
      const phrase = args.slice(2).join(' ').trim();
      if (!validPositiveId(id) || !['include', 'exclude', 'clear'].includes(field)
        || (field !== 'clear' && (!phrase || phrase.length > 100))) {
        reply = 'Usage: /filter ROUTE include|exclude KEYWORD (1–100 chars) or /filter ROUTE clear';
        break;
      }
      const exists = await query(env, 'SELECT id FROM routes WHERE id=?', id).first();
      if (!exists) { reply = 'Route not found.'; break; }
      if (field === 'clear') await query(env, 'UPDATE routes SET include_text=NULL,exclude_text=NULL WHERE id=?', id).run();
      else if (field === 'include') await query(env, 'UPDATE routes SET include_text=? WHERE id=?', phrase, id).run();
      else await query(env, 'UPDATE routes SET exclude_text=? WHERE id=?', phrase, id).run();
      await audit(env, 'filter_changed', id);
      reply = 'Text/caption filter saved. Messages without captions do not match include filters.';
      break;
    }
    case '/sender': {
      const id = numberArg(args[0]);
      const target = args[1];
      if (!validPositiveId(id) || args.length !== 2 ||
          !(target === 'clear' || /^\d{1,16}$/.test(target || ''))) {
        reply = 'Usage: /sender ROUTE USER_ID or /sender ROUTE clear';
        break;
      }
      const result = await query(env, 'UPDATE routes SET sender_id=? WHERE id=?',
        target === 'clear' ? null : target, id).run();
      reply = result.meta?.changes ? 'Source sender filter saved.' : 'Route not found.';
      break;
    }
    case '/filesize': {
      const id = numberArg(args[0]);
      if (!validPositiveId(id)) { reply = 'Usage: /filesize ROUTE MIN_BYTES MAX_BYTES or /filesize ROUTE clear'; break; }
      let min = null;
      let max = null;
      if (!(args.length === 2 && args[1] === 'clear')) {
        min = numberArg(args[1]);
        max = numberArg(args[2]);
        if (args.length !== 3 || !Number.isSafeInteger(min) || !Number.isSafeInteger(max)
            || min < 0 || min > max || max > 10 * 1024 * 1024 * 1024) {
          reply = 'Usage: /filesize ROUTE MIN_BYTES MAX_BYTES (up to 10 GiB), or /filesize ROUTE clear';
          break;
        }
      }
      const result = await query(env, 'UPDATE routes SET min_bytes=?,max_bytes=? WHERE id=?', min, max, id).run();
      reply = result.meta?.changes ? 'Media size filter saved.' : 'Route not found.';
      break;
    }
    case '/caption': {
      const id = numberArg(args[0]);
      const phrase = args.slice(1).join(' ').trim();
      if (!validPositiveId(id) || !phrase || phrase.length > 1024) {
        reply = 'Usage: /caption ROUTE NEW_CAPTION (max 1024 chars), or /caption ROUTE clear';
        break;
      }
      const route = await query(env, 'SELECT id FROM routes WHERE id=?', id).first();
      if (!route) { reply = 'Route not found.'; break; }
      await query(env, 'UPDATE routes SET caption_template=? WHERE id=?',
        phrase.toLowerCase() === 'clear' ? null : phrase, id).run();
      await audit(env, 'caption_changed', id);
      reply = 'Route caption saved; it overrides copyable media captions when copy mode is used.';
      break;
    }
    case '/disable': case '/enable': case '/delroute': {
      const id = numberArg(args[0]);
      if (!validPositiveId(id)) { reply = 'Provide a valid route ID.'; break; }
      if (name === '/enable') {
        const target = await query(env, 'SELECT * FROM routes WHERE id=?', id).first();
        const other = await rows(env, 'SELECT source,dest FROM routes WHERE id<>? AND enabled=1', id);
        if (!target || introducesCycle(other, target)) {
          reply = 'Route missing or would create a loop.';
          break;
        }
      }
      if (name === '/delroute') {
        const waiting = (await query(env, "SELECT count(*) AS n FROM jobs WHERE route_id=? AND state IN ('queued','sending','uncertain')", id).first()).n;
        if (waiting) { reply = 'Route has ' + waiting + ' unresolved jobs; resolve them first.'; break; }
        await query(env, 'DELETE FROM jobs WHERE route_id=?', id).run();
        await query(env, 'DELETE FROM routes WHERE id=?', id).run();
      } else {
        await query(env, 'UPDATE routes SET enabled=? WHERE id=?', name === '/enable' ? 1 : 0, id).run();
      }
      await audit(env, name.slice(1), id);
      reply = 'Route command completed.';
      break;
    }
    case '/batch': case '/copyone': case '/batchlinks': {
      const id = numberArg(args[0]);
      const links = name === '/batchlinks' ? [parseMessageLink(args[1]), parseMessageLink(args[2])] : [];
      const first = name === '/batchlinks' ? links[0]?.messageId : numberArg(args[1]);
      const last = name === '/copyone' ? first : name === '/batchlinks' ? links[1]?.messageId : numberArg(args[2]);
      const route = validPositiveId(id)
        ? await query(env, 'SELECT * FROM routes WHERE id=? AND enabled=1', id).first() : null;
      if (!route || Number(route.topic) !== 0 || !validPositiveId(first) || !validPositiveId(last)
        || (name === '/batchlinks' && (links.length !== 2 || !links.every(link => link && link.source === route.source)))
        || last < first || last - first + 1 > MAX_BATCH) {
        reply = 'Need an enabled topic-0 route and 1–50 known message IDs from its source; this is not history discovery.';
        break;
      }
      const pending = (await query(env, "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','sending','uncertain')").first()).n;
      if (pending + last - first + 1 > MAX_QUEUED) { reply = 'Queue full; resolve existing jobs.'; break; }
      await env.DB.batch(Array.from({length: last - first + 1},
        (_, i) => query(env, 'INSERT OR IGNORE INTO jobs(route_id,message_id) VALUES(?,?)', id, first + i)));
      await audit(env, 'batch_queued', id, null, first + '..' + last);
      reply = 'Queued IDs ' + first + '–' + last + '. Protected or inaccessible messages will fail safely.';
      break;
    }
    case '/jobs': {
      const jj = await rows(env, 'SELECT id,route_id,message_id,state,error FROM jobs ORDER BY id DESC LIMIT 20');
      reply = jj.length ? jj.map(j => '#' + j.id + ' route ' + j.route_id + ' msg ' + j.message_id +
        ' ' + j.state + (j.error ? ' (' + j.error + ')' : '')).join('\n') : 'No jobs.';
      break;
    }
    case '/cancel': case '/resume': case '/skip': case '/retry': case '/reconcile': {
      const id = numberArg(args[0]);
      if (!validPositiveId(id)) { reply = 'Provide a valid job ID.'; break; }
      if (name === '/retry' && args[1] !== 'CONFIRM') {
        reply = 'Uncertain sends might already have succeeded. Check destination; then /retry ID CONFIRM (duplicate risk).';
        break;
      }
      const sql = {
        '/cancel': "UPDATE jobs SET state='cancelled' WHERE id=? AND state='queued'",
        '/resume': "UPDATE jobs SET state='queued',error=NULL WHERE id=? AND state='cancelled'",
        '/skip': "UPDATE jobs SET state='skipped' WHERE id=? AND state IN ('failed','uncertain')",
        '/retry': "UPDATE jobs SET state='queued',error=NULL,due=0 WHERE id=? AND state='uncertain'",
        '/reconcile': "UPDATE jobs SET state='uncertain',error='send interrupted; check destination' WHERE id=? AND state='sending' AND claimed_at<?",
      }[name];
      await query(env, sql, ...(name === '/reconcile' ? [id, now() - 300] : [id])).run();
      await audit(env, name.slice(1), null, id);
      reply = 'Job command processed. Check /jobs.';
      break;
    }
    case '/stop':
      await setSetting(env, 'stopped', 1);
      await audit(env, 'emergency_stop');
      reply = 'Emergency stop ON. An in-flight request may still finish.';
      break;
    case '/run':
      await setSetting(env, 'stopped', 0);
      await audit(env, 'resume_queue');
      reply = 'Queue resumed; existing rate-limit cooldown still applies.';
      break;
    case '/stats': {
      const ss = await rows(env, 'SELECT state,count(*) AS n FROM jobs GROUP BY state ORDER BY state');
      reply = ss.length ? ss.map(s => s.state + ': ' + s.n).join('\n') : 'No job history.';
      break;
    }
    case '/status':
      reply = 'Stopped: ' + (await setting(env, 'stopped') || 0) +
        '; cooldown until (Unix): ' + (await setting(env, 'cooldown') || 0) +
        '; daily copy cap: ' + DAILY_SEND_CAP;
      break;
    case '/note':
      if (args.length) {
        await query(env, 'INSERT INTO notes(body) VALUES(?)', args.join(' ').slice(0, 2000)).run();
        reply = 'Note saved.';
      } else reply = 'Use /note TEXT';
      break;
    case '/notes': {
      const nn = await rows(env, 'SELECT id,body FROM notes ORDER BY id DESC LIMIT 10');
      reply = nn.length ? nn.map(n => '#' + n.id + ' ' + n.body).join('\n') : 'No notes.';
      break;
    }
    default: {
      const helpers = {...extensionHelpers(env), actorId: message.from?.id};
      let result = await handlePersonalCommand(env, name, args, helpers);
      if (result === null || result === undefined) result = await handleMessagingCommand(env, name, args, helpers);
      if (result === null || result === undefined) result = await handleAdminCommand(env, name, args, helpers);
      if (result === null || result === undefined) result = await formCommand(env, name, args, helpers);
      if (result !== null && result !== undefined) {
        if (result && typeof result === 'object') {
          reply = result.text;
          replyMarkup = result.reply_markup || null;
        } else reply = result;
      }
      break;
    }
  }
  await telegram(env, 'sendMessage', {chat_id: message.chat.id, text: safeReply(reply),
    ...(replyMarkup ? {reply_markup: replyMarkup} : {})});
}

async function canSendToday(env) {
  const day = new Date().toISOString().slice(0, 10);
  if (await setting(env, 'daily_day') !== day) {
    await setSetting(env, 'daily_day', day);
    await setSetting(env, 'daily_count', 0);
  }
  return Number(await setting(env, 'daily_count') || 0) < DAILY_SEND_CAP;
}

export async function drain(env) {
  if (await setting(env, 'stopped') === '1' || Number(await setting(env, 'cooldown') || 0) > now()) return;
  if (!(await canSendToday(env))) return;
  // Manual jobs run first, without subscribing to the linked source chat.
  const manual = await query(env, "UPDATE manual_jobs SET state='sending',attempts=attempts+1,claimed_at=? " +
    "WHERE id=(SELECT id FROM manual_jobs WHERE state='queued' AND due<=? ORDER BY id LIMIT 1) RETURNING *",
    now(), now()).first();
  // Atomic claim. Never automatically retry an unknown sending/uncertain job after a crash.
  const job = manual || await query(env, "UPDATE jobs SET state='sending',attempts=attempts+1,claimed_at=? " +
    "WHERE id=(SELECT j.id FROM jobs j JOIN routes r ON r.id=j.route_id " +
    "WHERE j.state='queued' AND j.due<=? AND r.enabled=1 ORDER BY j.id LIMIT 1) RETURNING *", now(), now()).first();
  if (!job) return;
  const table = manual ? 'manual_jobs' : 'jobs';
  const route = manual
    ? {source: manual.source, dest: manual.dest, dest_topic: manual.dest_topic, mode: 'copy', enabled: 1}
    : await query(env, 'SELECT * FROM routes WHERE id=?', job.route_id).first();
  if (!route?.enabled || await setting(env, 'stopped') === '1') {
    await query(env, "UPDATE " + table + " SET state='queued' WHERE id=?", job.id).run();
    return;
  }
  try {
    const destinationTopic = job.dest_topic_override ?? route.dest_topic;
    const {method, body} = deliveryCall({...route, dest_topic: destinationTopic}, job.message_id);
    if (!manual && method === 'copyMessage' && validPositiveId(job.reply_to_message_id)) {
      body.reply_parameters = {message_id: job.reply_to_message_id};
    }
    const delivered = await telegram(env, method, body);
    const destMessageId = delivered?.message_id;
    await query(env, 'INSERT OR IGNORE INTO archive_items(' +
      'source,source_message_id,dest,dest_topic,dest_message_id,route_id,media_kind,filename,caption_preview,saved_at) ' +
      'VALUES(?,?,?,?,?,?,?,?,?,?)',
      route.source, job.message_id, route.dest, destinationTopic, validPositiveId(destMessageId) ? destMessageId : null,
      manual ? null : route.id, job.media_kind || 'unknown', job.filename || null,
      job.caption_preview || null, now()).run();
    await query(env, "UPDATE " + table + " SET state='done',error=NULL WHERE id=?", job.id).run();
    await setSetting(env, 'daily_count', Number(await setting(env, 'daily_count') || 0) + 1);
    await audit(env, 'delivered', manual ? null : route.id, job.id, manual ? 'manual' : 'route');
  } catch (error) {
    const disposition = classifyError(error);
    if (disposition === 'rate_limit') {
      const pause = now() + Math.max(60, Math.min(86400, Number(error.retry) || 60));
      await setSetting(env, 'cooldown', pause);
      await query(env, "UPDATE " + table + " SET state='queued',due=?,error='rate limited' WHERE id=?", pause, job.id).run();
      await audit(env, 'rate_limited', manual ? null : route.id, job.id, manual ? 'manual' : 'route');
    } else {
      const state = disposition === 'halt' ? 'failed' : disposition;
      await query(env, 'UPDATE ' + table + ' SET state=?,error=? WHERE id=?', state,
        'API ' + (Number(error.code) || 'transport'), job.id).run();
      await audit(env, state, manual ? null : route.id, job.id, manual ? 'manual' : 'route');
      if (disposition === 'halt') await setSetting(env, 'stopped', 1);
      if (!manual && Number(error.code) === 403) await query(env, 'UPDATE routes SET enabled=0 WHERE id=?', route.id).run();
    }
  }
}

async function ingest(env, message) {
  if (!(await featureEnabled(env, 'archive'))) return;
  if (!message.chat || !validPositiveId(message.message_id)) return;
  const source = String(message.chat.id);
  const routes = await rows(env, 'SELECT * FROM routes WHERE source=? AND enabled=1', source);
  if (!routes.length) return;
  if (validPositiveId(message.message_thread_id)) {
    await query(env, 'INSERT INTO topics(chat,thread,title) VALUES(?,?,?) ' +
      'ON CONFLICT(chat,thread) DO UPDATE SET title=COALESCE(excluded.title,topics.title)',
      source, message.message_thread_id, message.forum_topic_created?.name || message.forum_topic_edited?.name || null).run();
  }
  if (message.forum_topic_edited?.name || message.forum_topic_created?.name) {
    const title = message.forum_topic_edited?.name || message.forum_topic_created?.name;
    for (const route of routes) {
      await syncTopicTitle(env, route, Number(message.message_thread_id || 0), title,
        (method, body) => telegram(env, method, body), now());
    }
  }
  if (await setting(env, 'stopped') === '1') return;
  const accepted = routes.filter(r => matchesExtendedFilters(message, r));
  if (!accepted.length) return;
  const pending = (await query(env, "SELECT count(*) AS n FROM jobs WHERE state IN ('queued','sending','uncertain')").first()).n;
  if (pending + accepted.length > MAX_QUEUED) { await audit(env, 'queue_full'); return; }
  const meta = fileMetadata(message);
  const statements = [];
  for (const route of accepted) {
    const result = await ingestMessagingUpdate(env, message, route, extensionHelpers(env));
    if (!result.accepted || result.handled || result.due == null) continue;
    statements.push(query(env,
      'INSERT OR IGNORE INTO jobs(route_id,message_id,media_kind,filename,caption_preview,due,dest_topic_override,reply_to_message_id) ' +
      'VALUES(?,?,?,?,?,?,?,?)',
      route.id, message.message_id, meta.kind, meta.filename, meta.caption, result.due,
      result.destinationTopic === route.dest_topic ? null : result.destinationTopic,
      result.replyParameters?.message_id || null));
  }
  if (statements.length) await env.DB.batch(statements);
}

async function mediaService(request, env, path) {
  if (!env.MEDIA_WORKER_KEY ||
      request.headers.get('X-Orbit-Service-Key') !== env.MEDIA_WORKER_KEY) {
    return new Response('Forbidden', {status: 403});
  }
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405});
  if (path === '/internal/media/claim') {
    if (await setting(env, 'stopped') === '1' || !(await featureEnabled(env, 'media_downloads'))) {
      return Response.json({job: null});
    }
    const job = await query(env, "UPDATE media_jobs SET state='running',claimed_at=?,attempts=attempts+1,progress_stage=NULL " +
      "WHERE id=(SELECT id FROM media_jobs WHERE state='queued' AND due<=? ORDER BY id LIMIT 1) RETURNING " +
      "id,url,kind,dest,dest_topic,quality,urls_json,options_json,parts_json,task,file_id", now(), now()).first();
    const materialized = job ? {
      id: job.id, url: job.url, kind: job.kind, dest: job.dest,
      dest_topic: job.dest_topic, quality: job.quality,
      ...(job.urls_json ? {urls: JSON.parse(job.urls_json)} : {}),
      ...(job.options_json ? {options: JSON.parse(job.options_json)} : {}),
      ...(job.parts_json ? {parts: JSON.parse(job.parts_json)} : {}),
      ...(job.task === 'transcribe' ? {task: 'transcribe', file_id: job.file_id} : {}),
    } : null;
    return Response.json({job: materialized}, {headers: {'Cache-Control': 'no-store'}});
  }
  if (path === '/internal/media/heartbeat' || path === '/internal/media/progress') {
    let data;
    try { data = await request.json(); } catch { return new Response('Bad JSON', {status: 400}); }
    if (!validPositiveId(data?.id)) return new Response('Invalid job ID', {status: 400});
    if (path.endsWith('/heartbeat')) {
      const result = await query(env,
        "UPDATE media_jobs SET claimed_at=? WHERE id=? AND state='running'", now(), data.id).run();
      return Response.json({ok: Boolean(result.meta?.changes)},
        {status: result.meta?.changes ? 200 : 409});
    }
    const stage = String(data.stage || '');
    const itemProgress = stage === 'uploaded_file' || stage === 'download_started';
    const bounded = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
    if (!/^[a-z_]{1,32}$/.test(stage)
        || !['bytes','total','speed_bps','eta_seconds','done'].every(key =>
          data[key] == null || bounded(data[key], key === 'eta_seconds' ? 604800 : 2147483647))) {
      return new Response('Invalid progress', {status: 400});
    }
    const progress = await query(env,
      'UPDATE media_jobs SET progress_stage=?,progress_bytes=?,progress_total_bytes=?,' +
      'progress_speed_bps=?,progress_eta_seconds=?,progress_done=?,progress_items_total=?,' +
      'progress_at=?,claimed_at=? WHERE id=? AND state=\'running\'',
      stage, data.bytes ?? null, itemProgress ? null : data.total ?? null,
      data.speed_bps ?? null, data.eta_seconds ?? null, data.done ?? null,
      itemProgress ? data.total ?? null : null,
      now(), now(), data.id).run();
    return Response.json({ok: Boolean(progress.meta?.changes)},
      {status: progress.meta?.changes ? 200 : 409});
  }
  if (path === '/internal/media/result') {
    let data;
    try { data = await request.json(); } catch { return new Response('Bad JSON', {status: 400}); }
    if (!validPositiveId(data.id) || !['done','failed','uncertain'].includes(data.status)) {
      return new Response('Invalid result', {status: 400});
    }
    const result = await query(env, "UPDATE media_jobs SET state=?,error=?,finished_at=? WHERE id=? AND state='running'",
      data.status, String(data.error || '').slice(0, 100) || null, now(), data.id).run();
    await audit(env, 'media_' + data.status, null, data.id, 'media');
    return Response.json({updated: (result.meta?.changes || 0) > 0});
  }
  return new Response('Not found', {status: 404});
}

export async function dueReminder(env) {
  if (await setting(env, 'stopped') === '1' || !(await featureEnabled(env, 'reminders'))) return;
  const reminder = await query(env, "UPDATE reminders SET state='sending' WHERE id=" +
    "(SELECT id FROM reminders WHERE state='queued' AND due<=? ORDER BY id LIMIT 1) RETURNING *", now()).first();
  if (!reminder) return;
  try {
    await telegram(env, 'sendMessage', {chat_id: env.OWNER_ID, text: '⏰ ' + reminder.body});
    await query(env, "UPDATE reminders SET state='done' WHERE id=?", reminder.id).run();
  } catch {
    // A transport failure might have occurred after Telegram delivered it.
    await query(env, "UPDATE reminders SET state='uncertain' WHERE id=?", reminder.id).run();
  }
}

async function groupAdmin(env, message, name, args) {
  const chatId = message.chat.id;
  const replyingTo = message.reply_to_message?.from?.id;
  const raw = replyingTo || args[0];
  const userId = parseTelegramUserId(raw);
  if (!userId || String(userId) === String(env.OWNER_ID)) {
    return 'Reply to a member or supply a valid user ID; owner is protected.';
  }
  const target = {chat_id: chatId, user_id: userId};
  switch (name) {
    case '/ban':
      await telegram(env, 'banChatMember', {...target, revoke_messages: false});
      break;
    case '/unban':
      await telegram(env, 'unbanChatMember', {...target, only_if_banned: true});
      break;
    case '/mute': {
      const duration = Number((replyingTo ? args[0] : args[1]) || 60);
      if (!Number.isSafeInteger(duration) || duration < 1 || duration > 10080) {
        return 'Mute duration must be 1–10080 minutes.';
      }
      await telegram(env, 'restrictChatMember', {...target,
        permissions: {can_send_messages: false},
        until_date: now() + duration * 60});
      break;
    }
    case '/unmute':
      await telegram(env, 'restrictChatMember', {...target, permissions: {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
        can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
        can_add_web_page_previews: true, can_invite_users: true,
      }});
      break;
    case '/promote':
      await telegram(env, 'promoteChatMember', {...target,
        can_manage_chat: true, can_delete_messages: true, can_pin_messages: true,
        can_manage_topics: true, can_promote_members: false,
        can_restrict_members: false, can_change_info: false,
      });
      break;
    case '/demote':
      await telegram(env, 'promoteChatMember', {...target,
        can_manage_chat: false, can_delete_messages: false, can_pin_messages: false,
        can_manage_topics: false, can_promote_members: false,
        can_restrict_members: false, can_change_info: false,
        can_invite_users: false,
      });
      break;
    default: return 'Unknown administration action.';
  }
  await audit(env, 'group_' + name.slice(1), null, null, String(userId));
  return 'Group operation ' + name + ' completed for user ' + userId + '.';
}

/** Only the owner can grant permissions. Delegated moderation is opt-in,
 * restricted to configured chats and atomically counted against daily quota.
 */
async function mayModerate(env, message, action) {
  if (!(await featureEnabled(env, 'group_admin'))) return false;
  if (String(message.from?.id) === String(env.OWNER_ID)) return true;
  if (!['/pin', '/unpin', '/delete', '/ban', '/unban', '/mute', '/unmute'].includes(action)) return false;
  if (!validPositiveId(message.from?.id)) return false;
  const chat = await query(env, 'SELECT enabled FROM admin_moderation_chats WHERE chat=?', String(message.chat.id)).first();
  if (!chat?.enabled) return false;
  const helpers = extensionHelpers(env);
  if (!(await checkAdminRole(env, message.from.id, 'moderate', helpers))) return false;
  return (await checkAndConsumeQuota(env, message.from.id, 'api', helpers)).allowed;
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/mini' || path === '/mini/' || path === '/mini/app.js' || path === '/mini/api') {
      return handleMiniHttp(request, env, extensionHelpers(env));
    }
    if (path === '/admin' || path === '/admin/' || path === '/admin/app.js' || path === '/admin/api') {
      return handleAdminHttp(request, env, extensionHelpers(env));
    }
    if (request.method === 'GET' && path === '/healthz') {
      return Response.json({ok: true, service: 'orbitsuite'});
    }
    if (path.startsWith('/internal/media/')) return mediaService(request, env, path);
    if (request.method !== 'POST') return new Response('OrbitSuite ready');
    if (!env.WEBHOOK_SECRET || !env.BOT_TOKEN || !env.OWNER_ID
      || request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', {status: 403});
    }
    let update;
    try { update = await request.json(); } catch { return new Response('Invalid JSON', {status: 400}); }
    const callback = update.callback_query;
    if (callback) {
      if (String(callback.from?.id) !== String(env.OWNER_ID)
          || String(callback.message?.chat?.id) !== String(env.OWNER_ID)) return success();
      const formAction = String(callback.data || '').startsWith('form:');
      const outcome = formAction
        ? await formCallback(callback.data, extensionHelpers(env))
        : await applyTopicChoice(env, callback.data, extensionHelpers(env));
      if (formAction && outcome) await telegram(env, 'sendMessage', {
        chat_id: callback.message.chat.id, text: safeReply(outcome),
      });
      if (typeof callback.id === 'string' && callback.id.length > 0 && callback.id.length <= 128) {
        await telegram(env, 'answerCallbackQuery', {
          callback_query_id: callback.id, text: safeReply(formAction ? 'Form selection received.' : outcome).slice(0, 190),
        });
      }
      return success();
    }
    const edited = update.edited_message || update.edited_channel_post;
    if (edited?.chat && validPositiveId(edited.message_id)) {
      if (await featureEnabled(env, 'archive')) {
        const routes = await rows(env, 'SELECT * FROM routes WHERE source=? AND enabled=1', String(edited.chat.id));
        for (const route of routes) {
          await propagateEditedMessage(env, edited, route, (method, body) => telegram(env, method, body));
        }
      }
      return success();
    }
    const message = update.message || update.channel_post;
    if (!message) return success();
    if (message.chat?.type === 'private') {
      if (String(message.from?.id) === String(env.OWNER_ID)) {
        const partMessage = await recordOwnerPart(env, message, extensionHelpers(env));
        if (partMessage) await telegram(env, 'sendMessage', {chat_id: message.chat.id, text: safeReply(partMessage)});
        else if (message.text && !(await formAnswer(message, extensionHelpers(env)))) await command(env, message);
      }
      else if (['/subscribe', '/unsubscribe'].includes((message.text || '').trim().split(/\s+/)[0])
          && await checkRequiredMembership(env, message.from?.id, extensionHelpers(env))) {
        await ingestPersonalUpdate(env, message, extensionHelpers(env));
      }
    } else {
      const moderation = await handleAdminUpdate(env, message, extensionHelpers(env));
      if (moderation.blocked) return success();
      const shortCommand = (message.text || '').trim().split(/\s+/)[0].split('@')[0].toLowerCase();
      if (shortCommand === '/id' && String(message.from?.id) === String(env.OWNER_ID)) {
        await telegram(env, 'sendMessage', {
          chat_id: message.chat.id,
          ...(message.message_thread_id ? {message_thread_id: message.message_thread_id} : {}),
          text: 'Chat: ' + message.chat.id + '\nTopic: ' + (message.message_thread_id || 0),
        });
      } else if (['/pin','/unpin','/delete'].includes(shortCommand)
          && await mayModerate(env, message, shortCommand)) {
        const target = message.reply_to_message?.message_id;
        if (validPositiveId(target)) {
          const operations = {
            '/pin': 'pinChatMessage',
            '/unpin': 'unpinChatMessage',
            '/delete': 'deleteMessage',
          };
          await telegram(env, operations[shortCommand], {chat_id: message.chat.id, message_id: target});
        }
      } else if (['/ban','/unban','/mute','/unmute','/promote','/demote'].includes(shortCommand)
          && await mayModerate(env, message, shortCommand)) {
        const args = (message.text || '').trim().split(/\s+/).slice(1);
        try {
          const result = await groupAdmin(env, message, shortCommand, args);
          await telegram(env, 'sendMessage', {
            chat_id: message.chat.id,
            ...(message.message_thread_id ? {message_thread_id: message.message_thread_id} : {}),
            text: safeReply(result),
          });
        } catch {
          await telegram(env, 'sendMessage', {
            chat_id: message.chat.id,
            text: 'Group action failed. Check bot and owner permissions.',
          });
        }
      } else {
        await ingestPersonalUpdate(env, message, extensionHelpers(env));
        await ingest(env, message);
      }
    }
    return success();
  },
  async scheduled(_event, env) {
    await drain(env);
    await dueReminder(env);
    await runMessagingScheduled(env, extensionHelpers(env));
    await runPersonalScheduled(env, extensionHelpers(env));
    await runAdminScheduled(env, extensionHelpers(env));
  },
};
