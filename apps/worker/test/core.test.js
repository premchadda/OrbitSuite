import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  eligible, validChat, validTopic, validPositiveId, matches, parseRouteArgs,
  introducesCycle, deliveryCall, classifyError, safeReply, MAX_BATCH, parseMessageLink,
  copyableContent, fileMetadata, mediaSize, parseTelegramUserId,
  safeMediaUrl,
} from '../src/core.js';

const message = {
  chat: {id: -100123456}, message_id: 42, message_thread_id: 4,
  document: {mime_type: 'application/pdf'},
};
const route = {source: '-100123456', topic: 4, dest: '-100987654', dest_topic: 33, kind: 'pdf', mode: 'copy'};

test('matches a PDF in the chosen source topic', () => assert.equal(eligible(message, route), true));
test('includes or excludes matching captions without regex execution', () => {
  assert.equal(eligible({...message, caption: 'SSC CGL 2026 Notes'}, {...route, include_text: 'cgl'}), true);
  assert.equal(eligible({...message, caption: 'SSC CGL 2026 Notes'}, {...route, exclude_text: 'cgl'}), false);
  assert.equal(eligible(message, {...route, include_text: 'cgl'}), false);
});
test('refuses other topics and source groups', () => {
  assert.equal(eligible(message, {...route, topic: 5}), false);
  assert.equal(eligible(message, {...route, source: '-100777777'}), false);
  assert.equal(eligible(message, {...route, topic: 0}), true);
});
test('protected messages and bot output are not queued', () => {
  assert.equal(eligible({...message, has_protected_content: true}, route), false);
  assert.equal(eligible({...message, chat: {...message.chat, has_protected_content: true}}, route), false);
  assert.equal(eligible({...message, from: {is_bot: true}}, route), false);
  assert.equal(eligible({...message, via_bot: {id: 8}}, route), false);
});
test('unsupported service messages and paid media do not enter the copy queue', () => {
  assert.equal(eligible({...message, forum_topic_created: {name: 'Test'}}, route), false);
  assert.equal(eligible({...message, paid_media: {}}, route), false);
  assert.equal(copyableContent({poll: {type: 'quiz'}}), false);
  assert.equal(copyableContent({poll: {type: 'regular'}}), true);
});
test('all supported media filters', () => {
  assert.equal(matches(message, 'pdf'), true);
  assert.equal(matches(message, 'video'), false);
  assert.equal(matches({voice: {}}, 'voice'), true);
  assert.equal(matches({animation: {}}, 'animation'), true);
  assert.equal(matches({sticker: {}}, 'sticker'), true);
  assert.equal(matches(message, 'document'), true);
  assert.equal(matches(message, 'all'), true);
  assert.equal(matches(message, 'garbage'), false);
});
test('strict route parser blocks invalid and unsafe parameters', () => {
  assert.equal(validChat('-100123456'), true);
  assert.equal(validChat('username'), false);
  assert.equal(validTopic(0), true);
  assert.equal(validTopic(-1), false);
  assert.equal(validPositiveId(10), true);
  assert.equal(validPositiveId(0), false);
  assert.deepEqual(parseRouteArgs(['-100123456', '4', '-100987654', '33', 'pdf', 'copy']), route);
  assert.equal(parseRouteArgs(['-100123456', '-1', '-100987654', '33']), null);
  assert.equal(parseRouteArgs(['-100123456', '4', '-100123456', '33']), null);
  assert.equal(parseRouteArgs(['-100123456', '4', '-100987654', 'bad']), null);
  assert.equal(parseRouteArgs(['-100123456', '4', '-100987654', '33', 'x']), null);
});
test('detects cycles through multiple chats', () => {
  assert.equal(introducesCycle([
    {source: 'a', dest: 'b'}, {source: 'b', dest: 'c'},
  ], {source: 'c', dest: 'a'}), true);
  assert.equal(introducesCycle([
    {source: 'a', dest: 'b'},
  ], {source: 'b', dest: 'c'}), false);
});
test('Bot API can copy or forward without passing media bytes through Worker', () => {
  const copy = deliveryCall(route, 42);
  assert.equal(copy.method, 'copyMessage');
  assert.deepEqual(copy.body, {
    chat_id: '-100987654', from_chat_id: '-100123456',
    message_id: 42, message_thread_id: 33, disable_notification: true,
  });
  assert.equal(deliveryCall({...route, mode: 'forward'}, 42).method, 'forwardMessage');
  assert.equal(deliveryCall({...route, caption_template: 'Orbit Archive'}, 42).body.caption, 'Orbit Archive');
  assert.equal(deliveryCall({...route, dest_topic: 0}, 42).body.message_thread_id, undefined);
});
test('uncertain transport failures are never silently requeued', () => {
  assert.equal(classifyError({code: 429}), 'rate_limit');
  assert.equal(classifyError({code: 403}), 'failed');
  assert.equal(classifyError({code: 400}), 'failed');
  assert.equal(classifyError({code: 401}), 'halt');
  assert.equal(classifyError({code: 500}), 'uncertain');
  assert.equal(classifyError(new TypeError('timeout')), 'uncertain');
  assert.equal(MAX_BATCH, 50);
  assert.equal(safeReply('z'.repeat(5000)).length, 3800);
});
test('manual save parses only supported Telegram message links', () => {
  assert.deepEqual(parseMessageLink('https://t.me/c/1234567890/405'),
    {source: '-1001234567890', messageId: 405});
  assert.deepEqual(parseMessageLink('https://t.me/c/1234567890/12/405'),
    {source: '-1001234567890', messageId: 405});
  assert.deepEqual(parseMessageLink('https://t.me/MyChannel/405'),
    {source: '@MyChannel', messageId: 405});
  assert.equal(parseMessageLink('https://evil.example/t.me/MyChannel/405'), null);
  assert.equal(parseMessageLink('https://t.me/+privateInvite'), null);
  assert.equal(parseMessageLink('https://t.me/c/1234567890/anything'), null);
  assert.equal(parseMessageLink('https://t.me/c/1234567890/0'), null);
  assert.equal(parseMessageLink('https://t.me/MyChannel/405#other'), null);
});
test('media job URL validation blocks local and non-HTTPS targets', () => {
  assert.equal(safeMediaUrl('https://www.youtube.com/watch?v=abc'), true);
  assert.equal(safeMediaUrl('http://example.com/video'), false);
  assert.equal(safeMediaUrl('https://127.0.0.1/data'), false);
  assert.equal(safeMediaUrl('https://myhost.local/test'), false);
  assert.equal(safeMediaUrl('https://user:password@example.com/video'), false);
  assert.equal(safeMediaUrl('not-a-url'), false);
});
test('extracts only bounded file metadata without media bytes', () => {
  const meta = fileMetadata({document: {mime_type: 'application/pdf',
    file_name: 'study.pdf'}, caption: 'SSC CGL notes'});
  assert.deepEqual(meta, {kind: 'pdf', filename: 'study.pdf', caption: 'SSC CGL notes'});
  assert.equal(fileMetadata({text: 'x'.repeat(200)}).caption.length, 160);
});
test('route sender and size guards reject unmatched media safely', () => {
  const uploaded = {...message, from: {id: 71}, document: {...message.document, file_size: 4096}};
  assert.equal(mediaSize(uploaded), 4096);
  assert.equal(mediaSize({photo: [{file_size: 200}, {file_size: 1500}]}), 1500);
  assert.equal(eligible(uploaded, {...route, sender_id: '71', min_bytes: 1024, max_bytes: 8192}), true);
  assert.equal(eligible(uploaded, {...route, sender_id: '72'}), false);
  assert.equal(eligible(uploaded, {...route, max_bytes: 1024}), false);
  assert.equal(eligible(uploaded, {...route, min_bytes: 5000}), false);
  assert.equal(eligible(message, {...route, min_bytes: 1}), false);
});
test('Telegram user IDs are validated separately from topic IDs', () => {
  assert.equal(parseTelegramUserId('1234567890123'), 1234567890123);
  assert.equal(parseTelegramUserId('0'), null);
  assert.equal(parseTelegramUserId('-123'), null);
  assert.equal(parseTelegramUserId('9007199254740999'), null);
});
