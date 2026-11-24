import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync, readdirSync} from 'node:fs';
import {
  handlePersonalCommand, ingestPersonalUpdate, runPersonalScheduled,
  safeFeedUrl, smartFilename, summarizeText, suggestTags, searchIntent,
  fetchRssFromParser, lookupFromParser,
} from '../src/personal_extensions.js';

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).sort()
    .filter(n => /^(000[1-9]|0011).*\.sql$/.test(n))) {
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  let clock = 1_700_000_000;
  const sent = [];
  const helpers = {
    ownerId: '12345',
    now: () => clock,
    query: (sql, ...args) => ({
      first: async () => db.prepare(sql).get(...args),
      all: async () => ({results: db.prepare(sql).all(...args)}),
      run: async () => ({meta: {changes: db.prepare(sql).run(...args).changes}}),
    }),
    rows: async (sql, ...args) => db.prepare(sql).all(...args),
    telegram: async (method, body) => { sent.push({method, body}); return {ok: true}; },
  };
  const env = {ORBIT_RSS_HOSTS: 'example.org,feeds.example.com'};
  const command = (name, ...args) => handlePersonalCommand(env, name, args, helpers);
  const flag = name => db.prepare('UPDATE feature_flags SET enabled=1 WHERE feature=?').run(name);
  const group = (text, extras = {}) => ({chat: {id: -1001234567890, type: 'supergroup'},
    from: {id: 2222}, text, message_thread_id: 9, ...extras});
  return {db, sent, helpers, env, command, flag, group, advance: n => {clock += n;},
    close: () => db.close()};
}

test('owner aliases are inert text expansions with strict names', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/alias', 'add', 'greeting', 'Hello', 'group'), /saved/);
  assert.equal(await f.command('/shortcut', 'greeting'), 'Hello group');
  assert.match(await f.command('/alias', 'list'), /greeting/);
  assert.match(await f.command('/alias', 'add', 'bad', '/ban'), /no command execution/);
  assert.match(await f.command('/alias', 'del', 'greeting'), /removed/);
  assert.equal(await f.command('/shortcut', 'greeting'), 'Alias not found.');
  assert.equal(await f.command('/not-ours'), null);
});

test('interactive prompt uses an anonymous owner-only Telegram native poll', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/prompt', 'Choose', 'subject', '|', 'Maths', '|', 'English'), /created/);
  assert.deepEqual(f.sent[0], {method: 'sendPoll', body: {chat_id: '12345',
    question: 'Choose subject', options: [{text: 'Maths'}, {text: 'English'}],
    type: 'regular', is_anonymous: true, disable_notification: true}});
  assert.match(await f.command('/prompt', 'Question', '|', 'onlyone'), /Use \/prompt/);
  assert.equal(f.sent.length, 1);
});

test('RSS registration rejects private, unknown, insecure and userinfo hosts', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(safeFeedUrl('https://feeds.example.com/rss', ['example.com']), true);
  for (const url of ['http://example.org/feed', 'https://user:pass@example.org/feed',
    'https://127.0.0.1/feed', 'https://unknown.example/feed',
    'https://example.org:8443/feed', 'https://example.org/feed#frag',
    'https://example.org.evil.test/feed']) {
    assert.equal(safeFeedUrl(url, ['example.org']), false, url);
  }
  assert.match(await f.command('/rss', 'add', '-1001234567890', '9', 'https://example.org/rss'), /saved/);
  assert.match(await f.command('/rss', 'add', '-1001234567890', '9', 'http://example.org/rss'), /allowlisted/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM personal_rss_feeds').get().n, 1);
  await f.command('/rss', 'add', '-1001234567890', '10', 'https://example.org/rss');
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM personal_rss_feeds').get().n, 2);
  assert.match(await f.command('/rss', 'list'), /example\.org/);
});

test('RSS scheduler uses opt-in flag, injected safe fetch, and GUID de-duplication', async t => {
  const f = fixture(); t.after(f.close);
  await f.command('/rss', 'add', '-1001234567890', '9', 'https://example.org/rss');
  let fetched = 0;
  f.helpers.fetchRss = async () => {fetched++; return [{guid: 'feed-guid-1', title: 'Study update',
    url: 'https://example.org/post'}];};
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 0);
  assert.equal(fetched, 0);
  f.flag('personal_rss');
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].body.message_thread_id, 9);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 0);
  f.advance(901);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 0);
  assert.equal(fetched, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM personal_rss_items').get().n, 1);
});

test('RSS HTTPS parser adapter never follows redirects and sends token only to trusted endpoint', async () => {
  const env = {ORBIT_RSS_HOSTS: 'example.org', ORBIT_RSS_PARSER_URL: 'https://parser.example.net',
    ORBIT_RSS_PARSER_TOKEN: 'SOME_TEST_TOKEN_12345678'};
  let requests = 0;
  const fakeFetch = async (url, options) => {
    requests++;
    assert.match(url, /^https:\/\/parser\.example\.net\/rss\?url=/);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer SOME_TEST_TOKEN_12345678');
    return Response.json({items: [{guid: 'a', title: 'Article', url: 'https://example.org/a'}]});
  };
  const items = await fetchRssFromParser(env, 'https://example.org/rss', fakeFetch);
  assert.equal(items[0].guid, 'a');
  await assert.rejects(fetchRssFromParser(env, 'http://example.org/rss', fakeFetch), /allowlisted/);
  assert.equal(requests, 1);
  const searchProvider = async (url, options) => {
    assert.match(url, /\/lookup\?kind=websearch&query=maths/);
    assert.equal(options.redirect, 'error');
    return Response.json({result: 'Maths: https://en.wikipedia.org/?curid=1'});
  };
  assert.match(await lookupFromParser(env, 'websearch', 'maths', searchProvider), /Maths/);
  await assert.rejects(fetchRssFromParser({...env, ORBIT_RSS_PARSER_URL: 'http://127.0.0.1:8080'},
    'https://example.org/rss', fakeFetch), /HTTPS endpoint/);
});

test('uncertain RSS delivery reserves GUID and does not block subscribed announcement', async t => {
  const f = fixture(); t.after(f.close);
  await f.command('/rss', 'add', '-1001234567890', '9', 'https://example.org/rss');
  f.flag('personal_rss'); f.flag('personal_broadcasts');
  await ingestPersonalUpdate(f.env, {chat: {id: 7777, type: 'private'}, from: {id: 7777},
    text: '/subscribe'}, f.helpers);
  await f.command('/announce', '1', 'One-time', 'note');
  f.advance(61);
  f.helpers.fetchRss = async () => [{guid: 'g-uncertain', title: 'Hello'}];
  const originalTelegram = f.helpers.telegram;
  f.helpers.telegram = async (method, body) => {
    if (body.chat_id === '-1001234567890') throw new Error('possible ambiguous send');
    return originalTelegram(method, body);
  };
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 1);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM personal_rss_items').get().n, 1);
  assert.equal(f.sent.at(-1).body.text, 'One-time note');
});

test('auto-reply and recipes are off until enabled and throttled per rule', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/autoreply', 'add', '-1001234567890', 'hello', '|', 'Hi there'), /saved/);
  assert.equal(await ingestPersonalUpdate(f.env, f.group('hello'), f.helpers), false);
  f.flag('personal_auto_replies');
  assert.equal(await ingestPersonalUpdate(f.env, f.group('hello'), f.helpers), true);
  assert.equal(f.sent[0].body.text, 'Hi there');
  assert.equal(await ingestPersonalUpdate(f.env, f.group('hello'), f.helpers), false);
  f.advance(61);
  assert.equal(await ingestPersonalUpdate(f.env, f.group('hello', {from: {id: 12345}}), f.helpers), false);
  assert.equal(await ingestPersonalUpdate(f.env, f.group('hello', {has_protected_content: true}), f.helpers), false);
  assert.equal(await ingestPersonalUpdate(f.env, f.group('hello'), f.helpers), true);
  await f.command('/recipe', 'add', '-1001234567890', 'study', '|', 'Study hard');
  f.flag('personal_workflows');
  assert.equal(await ingestPersonalUpdate(f.env, f.group('study'), f.helpers), true);
  assert.equal(f.sent.at(-1).body.text, 'Study hard');
});

test('opt-in announcements send exclusively to opted-in users, one per tick', async t => {
  const f = fixture(); t.after(f.close);
  const subscriber = userId => ({chat: {type: 'private', id: userId}, from: {id: userId}, text: '/subscribe'});
  assert.equal(await ingestPersonalUpdate(f.env, subscriber(7777), f.helpers), false);
  assert.equal((await f.command('/announce', '1', 'Hello', 'all')), 'Opt-in announcements are OFF.');
  f.flag('personal_broadcasts');
  assert.equal(await ingestPersonalUpdate(f.env, subscriber(7777), f.helpers), true);
  assert.equal(await ingestPersonalUpdate(f.env, subscriber(8888), f.helpers), true);
  assert.match(await f.command('/subscribers'), /2/);
  assert.match(await f.command('/announce', '1', 'Personal', 'notice'), /queued/);
  f.advance(61);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 1);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 1);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 0);
  const announcements = f.sent.filter(item => item.body.text === 'Personal notice');
  assert.deepEqual(announcements.map(item => Number(item.body.chat_id)), [7777, 8888]);
  assert.equal(await ingestPersonalUpdate(f.env, { ...subscriber(7777), text: '/unsubscribe' }, f.helpers), true);
  assert.match(await f.command('/subscribers'), /1/);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM personal_announcement_targets WHERE state=?').get('done').n, 2);
});

test('unsubscribe revokes queued announcement deliveries before sending', async t => {
  const f = fixture(); t.after(f.close);
  f.flag('personal_broadcasts');
  for (const user of [7777, 8888]) {
    await ingestPersonalUpdate(f.env, {chat: {id: user, type: 'private'}, from: {id: user},
      text: '/subscribe'}, f.helpers);
  }
  await f.command('/announce', '1', 'Only', 'first', 'user');
  f.advance(61);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 1);
  await ingestPersonalUpdate(f.env, {chat: {id: 8888, type: 'private'}, from: {id: 8888},
    text: '/unsubscribe'}, f.helpers);
  assert.equal(await runPersonalScheduled(f.env, f.helpers), 0);
  const deliveries = f.sent.filter(x => x.body.text === 'Only first user');
  assert.deepEqual(deliveries.map(x => Number(x.body.chat_id)), [7777]);
  assert.equal(f.db.prepare("SELECT state FROM personal_announcement_targets WHERE user_id='8888'").get().state,
    'cancelled');
});

test('AFK replies only to owner mentions and uses 10-minute per-chat cooldown', async t => {
  const f = fixture(); t.after(f.close);
  assert.match(await f.command('/afk', 'Having', 'dinner'), /enabled/);
  const reply = f.group('Are you there?', {reply_to_message: {from: {id: 12345}}});
  assert.equal(await ingestPersonalUpdate(f.env, reply, f.helpers), false);
  f.flag('personal_afk');
  assert.equal(await ingestPersonalUpdate(f.env, reply, f.helpers), true);
  assert.match(f.sent.at(-1).body.text, /Having dinner/);
  assert.equal(await ingestPersonalUpdate(f.env, reply, f.helpers), false);
  f.advance(601);
  assert.equal(await ingestPersonalUpdate(f.env, reply, f.helpers), true);
  await f.command('/back');
  f.advance(601);
  assert.equal(await ingestPersonalUpdate(f.env, reply, f.helpers), false);
});

test('offline metadata, natural-language search and external lookup adapter stay bounded', async t => {
  const f = fixture(); t.after(f.close);
  assert.equal(smartFilename('../Maths: SSC CGL\u0000 Notes.pdf'), 'Maths_SSC_CGL_Notes.pdf');
  assert.deepEqual(suggestTags('SSC CGL English notes PDF'), ['ssc', 'english', 'document']);
  assert.match(summarizeText('A sentence. Another sentence. Third sentence.'), /Another sentence/);
  assert.deepEqual(searchIntent('Find pdf about geometry on 2026-11-24'),
    {type: 'pdf', date: '2026-11-24', query: 'geometry'});
  f.db.prepare('INSERT INTO archive_items(source,source_message_id,dest,dest_topic,media_kind,'
    + 'filename,caption_preview,saved_at) VALUES(?,?,?,?,?,?,?,?)')
    .run('-1001234567890', 44, '-1001234567890', 9, 'pdf', 'Geometry SSC.pdf', 'SSC notes',
      Math.floor(Date.parse('2026-11-24T05:00:00Z') / 1000));
  assert.match(await f.command('/searchnl', 'Find', 'pdf', 'geometry', '2026-11-24'), /Geometry SSC\.pdf/);
  assert.match(await f.command('/wiki', 'Albert', 'Einstein'), /not configured/);
  f.helpers.lookup = async (kind, q) => kind + ':' + q;
  assert.equal(await f.command('/translate', 'Hello'), 'translate:Hello');
  assert.match(await f.command('/menu'), /searchnl/);
});

test('self-hosted private parser works only with explicit authenticated loopback opt-in', async () => {
  const env = {ORBIT_RSS_HOSTS: 'feeds.example.com',
    ORBIT_RSS_PARSER_URL: 'http://127.0.0.1:8188',
    ORBIT_RSS_PARSER_TOKEN: 'a-distinct-parser-secret-123456',
    ORBIT_RSS_ALLOW_LOCAL_HTTP: '1'};
  const seen = [];
  const fake = async (url, options) => {
    seen.push({url, options});
    const body = url.includes('/lookup') ? {result: 'A safe Wiki answer'}
      : {items: [{title: 'News', url: 'https://feeds.example.com/story'}]};
    return new Response(JSON.stringify(body), {headers: {'content-type': 'application/json'}});
  };
  assert.equal(await lookupFromParser(env, 'wiki', 'Physics', fake), 'A safe Wiki answer');
  assert.equal((await fetchRssFromParser(env, 'https://feeds.example.com/rss', fake))[0].title, 'News');
  assert.equal(seen.length, 2);
  assert.match(seen[0].url, /^http:\/\/127\.0\.0\.1:8188\/lookup\?/);
  assert.equal(seen[0].options.headers.Authorization, 'Bearer ' + env.ORBIT_RSS_PARSER_TOKEN);
  assert.equal(seen[0].options.redirect, 'error');
  await assert.rejects(lookupFromParser({...env, ORBIT_RSS_ALLOW_LOCAL_HTTP: '0'},
    'wiki', 'Physics', fake));
  await assert.rejects(lookupFromParser({...env, ORBIT_RSS_PARSER_URL: 'http://example.com:8188'},
    'wiki', 'Physics', fake));
  await assert.rejects(fetchRssFromParser(env, 'https://unapproved.example/rss', fake));
  assert.equal(seen.length, 2);
});
