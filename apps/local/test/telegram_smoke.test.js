import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inspectTelegram} from '../../../infra/windows/telegram-smoke.mjs';

const cfg = {BOT_TOKEN: '12345:ABCDEFGHIJKLMNOPQRSTUVWX', OWNER_ID: '777777',
  ORBIT_MODE: 'polling', ORBIT_TEST_CHAT_ID: '-1001234567890'};

test('read-only Telegram preflight verifies bot, webhook, forum and permissions', async () => {
  const methods = [];
  const replies = {
    getMe: {id: 12345, username: 'orbit_test_bot'},
    getWebhookInfo: {url: ''},
    getChat: {type: 'supergroup', is_forum: true},
    getChatMember: {status: 'administrator', can_manage_topics: true,
      can_delete_messages: true},
  };
  const fakeFetch = async (url, options) => {
    const method = url.split('/').at(-1);
    assert.ok(method in replies);
    assert.equal(options.method, 'POST');
    methods.push(method);
    return {ok: true, status: 200, json: async () => ({ok: true, result: replies[method]})};
  };
  const result = await inspectTelegram(cfg, fakeFetch);
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo', 'getChat', 'getChatMember']);
  assert.equal(result.test_chat_forum, true);
  assert.equal(result.test_chat_can_manage_topics, true);
  assert.equal(result.webhook_active, false);
  assert.equal(JSON.stringify(result).includes(cfg.BOT_TOKEN), false);
});

test('placeholder token and invalid group are rejected without network calls', async () => {
  const failIfCalled = () => {throw new Error('unexpected network call');};
  await assert.rejects(inspectTelegram({...cfg, BOT_TOKEN: 'REPLACE_WITH_TOKEN'}, failIfCalled),
    /BOT_TOKEN/);
  await assert.rejects(inspectTelegram({...cfg, ORBIT_TEST_CHAT_ID: 'alice'}, failIfCalled),
    /ORBIT_TEST_CHAT_ID/);
  await assert.rejects(inspectTelegram({...cfg, ORBIT_TEST_DEST_CHAT_ID: cfg.ORBIT_TEST_CHAT_ID}, failIfCalled),
    /different/);
});

test('staging checker checks two distinct Telegram chats', async () => {
  const chats = [];
  const result = await inspectTelegram({...cfg, ORBIT_TEST_DEST_CHAT_ID: '-1009876543210'},
    async (url, options) => {
      const method = url.split('/').at(-1);
      if (method === 'getChat') chats.push(JSON.parse(options.body).chat_id);
      const response = {
        getMe: {id: 12345}, getWebhookInfo: {url: ''},
        getChat: {type: 'supergroup', is_forum: true},
        getChatMember: {status: 'administrator'},
      }[method];
      return {ok: true, status: 200, json: async () => ({ok: true, result: response})};
    });
  assert.deepEqual(chats, ['-1001234567890', '-1009876543210']);
  assert.equal(result.destination_chat_forum, true);
});

test('active webhook is reported without modifying Telegram state', async () => {
  const methods = [];
  const result = await inspectTelegram({...cfg, ORBIT_TEST_CHAT_ID: ''}, async url => {
    const method = url.split('/').at(-1);
    methods.push(method);
    return {ok: true, status: 200, json: async () => ({ok: true, result:
      method === 'getMe' ? {id: 12345, username: 'bot'} : {url: 'https://example.org/hook'}})};
  });
  assert.equal(result.webhook_active, true);
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo']);
});

test('Telegram failures report status without leaking token or error response', async () => {
  await assert.rejects(inspectTelegram(cfg, async () => ({ok: false, status: 401,
    json: async () => ({ok: false, description: cfg.BOT_TOKEN})})), error => {
    assert.match(error.message, /HTTP 401/);
    assert.ok(!error.message.includes(cfg.BOT_TOKEN));
    return true;
  });
});
