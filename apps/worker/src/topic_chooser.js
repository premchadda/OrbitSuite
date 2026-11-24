/** Minimal private owner topic picker using Telegram's native inline buttons.
 * No Mini App origin, web session, arbitrary callback handler, or chat scan.
 */
import {validPositiveId} from './core.js';

const query = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const integer = text => /^\d+$/.test(String(text || '')) ? Number(text) : null;

export async function buildTopicChooser(env, args) {
  const id = integer(args[0]);
  const side = args[1];
  if (!validPositiveId(id) || !['source', 'dest'].includes(side) || args.length !== 2) {
    return {text: 'Use /topicchoose ROUTE_ID source|dest. Discover topics with /id first.'};
  }
  const route = await query(env, 'SELECT * FROM routes WHERE id=?', id).first();
  if (!route) return {text: 'Route not found. Use /routes.'};
  const chat = side === 'source' ? route.source : route.dest;
  const {results: found} = await query(env,
    'SELECT thread,title FROM topics WHERE chat=? ORDER BY thread DESC LIMIT 14', chat).all();
  const options = [{thread: 0, title: side === 'source' ? 'Any source topic' : 'Default destination'}];
  for (const item of found || []) {
    if (!validPositiveId(item.thread)) continue;
    options.push({thread: item.thread, title: item.title || 'Thread ' + item.thread});
  }
  const keyboard = options.map(item => [{
    text: String(item.title).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 45) + ' · ' + item.thread,
    callback_data: 'topic:' + id + ':' + (side === 'source' ? 's' : 'd') + ':' + item.thread,
  }]);
  return {
    text: 'Route #' + id + ' — choose observed ' + side + ' topic in chat ' + chat +
      '. Current: ' + (side === 'source' ? route.topic : route.dest_topic) +
      '.\nButtons change this route only. New topics appear after a routed group update.',
    reply_markup: {inline_keyboard: keyboard},
  };
}

export async function applyTopicChoice(env, raw, helpers = {}) {
  const match = /^topic:([1-9]\d{0,8}):(s|d):(0|[1-9]\d{0,9})$/.exec(String(raw || ''));
  if (!match) return 'Invalid topic selection.';
  const id = Number(match[1]);
  const thread = Number(match[3]);
  if (!validPositiveId(id) || !Number.isSafeInteger(thread)) return 'Invalid topic or route ID.';
  const route = await query(env, 'SELECT * FROM routes WHERE id=?', id).first();
  if (!route) return 'Route no longer exists.';
  const isSource = match[2] === 's';
  if (!isSource && thread !== 0 && Number(route.auto_topics)) {
    return 'Turn off /autotopics for this route before choosing one destination topic.';
  }
  if (thread > 0) {
    const chat = isSource ? route.source : route.dest;
    const observed = await query(env, 'SELECT 1 FROM topics WHERE chat=? AND thread=?', chat, thread).first();
    if (!observed) return 'This topic was not observed in the selected chat.';
  }
  const sourceTopic = isSource ? thread : route.topic;
  const destinationTopic = isSource ? route.dest_topic : thread;
  const duplicate = await query(env,
    'SELECT id FROM routes WHERE source=? AND topic=? AND dest=? AND dest_topic=? AND id<>?',
    route.source, sourceTopic, route.dest, destinationTopic, id).first();
  if (duplicate) return 'Route #' + duplicate.id + ' already uses this mapping.';
  const column = isSource ? 'topic' : 'dest_topic';
  const result = await query(env, 'UPDATE routes SET ' + column + '=? WHERE id=?', thread, id).run();
  if (!result.meta?.changes) return 'Route not changed.';
  await helpers.audit?.('topic_selected', id, null, column + ':' + thread);
  return 'Route #' + id + ' ' + (isSource ? 'source' : 'destination') +
    ' topic set to ' + thread + '. Verify bot permissions with /checkroute ' + id + '.';
}
