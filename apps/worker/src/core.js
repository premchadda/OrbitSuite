/** Pure rules for a private Telegram Bot API relay. */
export const MEDIA_KINDS = new Set(['all', 'pdf', 'document', 'video', 'photo', 'audio', 'voice', 'animation', 'sticker']);
export const DELIVERY_MODES = new Set(['copy', 'forward']);
export const MAX_BATCH = 50;
const UNSUPPORTED_COPY_FIELDS = [
  'paid_media', 'giveaway', 'giveaway_winners', 'invoice',
  'new_chat_members', 'left_chat_member', 'new_chat_title', 'new_chat_photo',
  'delete_chat_photo', 'group_chat_created', 'supergroup_chat_created',
  'channel_chat_created', 'message_auto_delete_timer_changed',
  'migrate_to_chat_id', 'migrate_from_chat_id', 'pinned_message',
  'forum_topic_created', 'forum_topic_edited', 'forum_topic_closed',
  'forum_topic_reopened', 'video_chat_started', 'video_chat_ended',
  'video_chat_participants_invited', 'video_chat_scheduled',
  'successful_payment', 'users_shared', 'chat_shared',
];
export function copyableContent(message) {
  if (!message || UNSUPPORTED_COPY_FIELDS.some(field => message[field] !== undefined)) return false;
  // The Bot API can only copy quiz polls when the bot knows the correct answer.
  if (message.poll?.type === 'quiz' && message.poll.correct_option_id === undefined
      && !message.poll.correct_option_ids?.length) return false;
  return true;
}

export function validChat(value) {
  return typeof value === 'string' && /^-100\d{5,16}$/.test(value);
}
export function validTopic(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
}
export function validPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
}
/** Telegram user identifiers can be larger than forum-topic IDs. */
export function parseTelegramUserId(value) {
  const raw = String(value ?? '');
  if (!/^[1-9]\d{0,15}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
/** Only public channel posts or private channel/group links visible to the bot. */
export function parseMessageLink(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!['https:', 'http:'].includes(url.protocol)
    || !['t.me', 'telegram.me'].includes(url.hostname.toLowerCase())
    || url.username || url.password || url.port || url.hash) return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2 || parts.length > 4) return null;
  const messageId = Number(parts.at(-1));
  if (!/^\d+$/.test(parts.at(-1)) || !validPositiveId(messageId)) return null;
  if (parts[0] === 'c') {
    if (![3, 4].includes(parts.length) || !/^[1-9]\d{4,15}$/.test(parts[1])) return null;
    if (parts.length === 4 && (!/^\d+$/.test(parts[2]) || !validPositiveId(Number(parts[2])))) return null;
    return { source: '-100' + parts[1], messageId };
  }
  if (![2, 3].includes(parts.length) || !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(parts[0])) return null;
  if (parts.length === 3 && (!/^\d+$/.test(parts[1]) || !validPositiveId(Number(parts[1])))) return null;
  return { source: '@' + parts[0], messageId };
}
export function safeMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return false;
  let u;
  try { u = new URL(raw); } catch { return false; }
  const host = u.hostname.toLowerCase();
  return u.protocol === 'https:' && !u.username && !u.password && !u.port
    && host.includes('.') && !host.endsWith('.local')
    && !host.endsWith('.internal') && host !== 'localhost'
    && !/^\d+(?:\.\d+){3}$/.test(host)
    && !host.includes(':') && !u.hash;
}
export function matches(message, kind) {
  if (kind === 'all') return true;
  if (kind === 'pdf') return message.document?.mime_type === 'application/pdf';
  if (kind === 'document') return Boolean(message.document);
  return ['video', 'photo', 'audio', 'voice', 'animation', 'sticker'].includes(kind) && Boolean(message[kind]);
}
/** Extract bounded, non-media metadata only, for a searchable archive index. */
export function fileMetadata(message) {
  const kind = ['document', 'video', 'photo', 'audio', 'voice', 'animation', 'sticker', 'video_note']
    .find(type => message?.[type] !== undefined) || 'text';
  const attachment = message?.[kind];
  return {
    kind: kind === 'document' && attachment?.mime_type === 'application/pdf' ? 'pdf' : kind,
    filename: typeof attachment?.file_name === 'string'
      ? attachment.file_name.slice(0, 180) : null,
    caption: String(message?.caption || message?.text || '').slice(0, 160),
  };
}
export function mediaSize(message) {
  const fields = ['document', 'video', 'audio', 'voice', 'animation', 'sticker', 'video_note'];
  for (const field of fields) {
    const bytes = message?.[field]?.file_size;
    if (Number.isSafeInteger(bytes) && bytes >= 0) return bytes;
  }
  if (Array.isArray(message?.photo)) {
    const sizes = message.photo.map(photo => photo.file_size).filter(bytes =>
      Number.isSafeInteger(bytes) && bytes >= 0);
    if (sizes.length) return Math.max(...sizes);
  }
  return null;
}
export function eligible(message, route) {
  const text = String(message?.text || message?.caption || '').toLocaleLowerCase();
  const include = String(route.include_text || '').toLocaleLowerCase();
  const exclude = String(route.exclude_text || '').toLocaleLowerCase();
  const size = mediaSize(message);
  return Boolean(message?.chat && copyableContent(message)
    && !message.has_protected_content && !message.chat.has_protected_content
    && !message.from?.is_bot && !message.via_bot
    && String(message.chat.id) === String(route.source)
    && (Number(route.topic) === 0 || Number(route.topic) === Number(message.message_thread_id || 0))
    && (!route.sender_id || String(message.from?.id || message.sender_chat?.id || '') === route.sender_id)
    && (route.min_bytes == null || (size !== null && size >= route.min_bytes))
    && (route.max_bytes == null || (size !== null && size <= route.max_bytes))
    && (!include || text.includes(include))
    && (!exclude || !text.includes(exclude))
    && matches(message, route.kind));
}
export function parseRouteArgs(args) {
  const [source, sourceTopic, dest, destTopic, kind = 'all', mode = 'copy'] = args;
  const topic = Number(sourceTopic);
  const destinationTopic = Number(destTopic);
  if (!validChat(source) || !validChat(dest) || source === dest
    || !/^\d+$/.test(sourceTopic ?? '') || !/^\d+$/.test(destTopic ?? '')
    || !validTopic(topic) || !validTopic(destinationTopic)
    || !MEDIA_KINDS.has(kind) || !DELIVERY_MODES.has(mode)) return null;
  return { source, topic, dest, dest_topic: destinationTopic, kind, mode };
}
/** Refuse chat-level loops, including longer forwarding cycles. */
export function introducesCycle(routes, proposed) {
  const edges = new Map();
  for (const route of [...routes, proposed]) {
    if (!edges.has(route.source)) edges.set(route.source, new Set());
    edges.get(route.source).add(route.dest);
  }
  const queue = [proposed.dest];
  const seen = new Set();
  for (let i = 0; i < queue.length; i++) {
    const chat = queue[i];
    if (chat === proposed.source) return true;
    if (seen.has(chat)) continue;
    seen.add(chat);
    for (const next of edges.get(chat) || []) queue.push(next);
  }
  return false;
}
export function deliveryCall(route, messageId) {
  const body = {
    chat_id: route.dest,
    from_chat_id: route.source,
    message_id: messageId,
    ...(route.dest_topic ? {message_thread_id: route.dest_topic} : {}),
    disable_notification: true,
    ...(route.mode !== 'forward' && route.caption_template
      ? {caption: route.caption_template} : {}),
  };
  return { method: route.mode === 'forward' ? 'forwardMessage' : 'copyMessage', body };
}
export function classifyError(error) {
  const code = Number(error?.code || 0);
  if (code === 429) return 'rate_limit';
  if (code === 400 || code === 403) return 'failed';
  if (code === 401) return 'halt';
  return 'uncertain'; // timeout/transport/5xx: send may already have happened
}
export function safeReply(text) {
  return String(text).slice(0, 3800);
}
