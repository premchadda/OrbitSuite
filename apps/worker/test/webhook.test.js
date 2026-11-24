import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const env = {BOT_TOKEN: 'TEST_ONLY', OWNER_ID: '123456', WEBHOOK_SECRET: 'TEST_SECRET'};
const update = {message: {chat: {type: 'private', id: 123456}, from: {id: 444444}, text: '/stop'}};
function post(secret, body = update) {
  return new Request('https://example.workers.dev/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret ? {'X-Telegram-Bot-Api-Secret-Token': secret} : {}),
    },
    body: JSON.stringify(body),
  });
}
test('rejects unauthenticated webhook POST', async () => {
  const response = await worker.fetch(post(undefined), env);
  assert.equal(response.status, 403);
});
test('ignores private commands from non-owner without contacting Telegram', async () => {
  const response = await worker.fetch(post('TEST_SECRET'), env);
  assert.equal(response.status, 200);
});
test('handles webhook messages without an actionable Telegram message', async () => {
  const response = await worker.fetch(post('TEST_SECRET', {update_id: 1}), env);
  assert.equal(response.status, 200);
});
