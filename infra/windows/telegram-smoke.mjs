/** Read-only Telegram API preflight. Never prints bot tokens, URLs or message data. */
import {isDirectEntrypoint} from '../../apps/local/src/entrypoint.js';

const TOKEN = /^\d+:[A-Za-z0-9_-]{20,}$/;

export async function inspectTelegram(config, fetchImpl = globalThis.fetch) {
  const token = String(config.BOT_TOKEN || '');
  if (!TOKEN.test(token)) throw new Error('BOT_TOKEN is missing or has an invalid BotFather-token format');
  if (!/^\d+$/.test(String(config.OWNER_ID || ''))) throw new Error('OWNER_ID must be numeric');
  if (config.ORBIT_MODE && config.ORBIT_MODE !== 'polling') {
    throw new Error('The Windows live staging kit expects ORBIT_MODE=polling');
  }
  const chatId = String(config.ORBIT_TEST_CHAT_ID || '').trim();
  const destId = String(config.ORBIT_TEST_DEST_CHAT_ID || '').trim();
  for (const [key, id] of [['ORBIT_TEST_CHAT_ID', chatId], ['ORBIT_TEST_DEST_CHAT_ID', destId]]) {
    if (id && !/^-\d{5,}$/.test(id)) throw new Error(key + ' must be a negative Telegram group ID');
  }
  if (chatId && destId && chatId === destId) {
    throw new Error('Source and destination test chats must be different');
  }

  async function readOnly(method, payload = {}) {
    let response;
    try {
      response = await fetchImpl('https://api.telegram.org/bot' + token + '/' + method, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(payload), signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Telegram ' + method + ' transport failed (check Internet/DNS/TLS)');
    }
    let parsed;
    try {parsed = await response.json();}
    catch {throw new Error('Telegram ' + method + ' returned invalid JSON');}
    if (!response.ok || parsed?.ok !== true) {
      throw new Error('Telegram ' + method + ' failed (HTTP ' + response.status + ')');
    }
    return parsed.result;
  }

  const bot = await readOnly('getMe');
  const hook = await readOnly('getWebhookInfo');
  const result = {
    token_valid_on_telegram: true,
    bot_username: String(bot.username || ''),
    owner_id_numeric: true,
    webhook_active: Boolean(hook.url),
    test_chat_configured: Boolean(chatId),
    destination_chat_configured: Boolean(destId),
  };
  for (const [prefix, id] of [['test_chat', chatId], ['destination_chat', destId]]) {
    if (!id) continue;
    const chat = await readOnly('getChat', {chat_id: id});
    const membership = await readOnly('getChatMember', {chat_id: id, user_id: bot.id});
    result[prefix + '_type'] = String(chat.type || 'unknown');
    result[prefix + '_forum'] = chat.is_forum === true;
    result[prefix + '_bot_status'] = String(membership.status || 'unknown');
    result[prefix + '_can_manage_topics'] = membership.can_manage_topics === true;
    result[prefix + '_can_delete_messages'] = membership.can_delete_messages === true;
  }
  return result;
}

if (isDirectEntrypoint(import.meta.url)) {
  try {
    const result = await inspectTelegram(process.env);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.webhook_active) {
      process.stderr.write('A webhook is configured. Review and remove it explicitly before polling; do not drop pending updates.\n');
      process.exitCode = 2;
    }
    if (!result.test_chat_configured || !result.destination_chat_configured) {
      process.stderr.write('Set ORBIT_TEST_CHAT_ID and ORBIT_TEST_DEST_CHAT_ID for both staging chats.\n');
    }
  } catch (error) {
    process.stderr.write('Read-only Telegram smoke test failed: ' + error.message + '\n');
    process.exitCode = 1;
  }
}
