# Troubleshooting

Real errors, with the real cause and the real fix — most of this library
exists specifically because these bugs happened in a live production bot.

## `[400 BOT_METHOD_INVALID] - The specified method cannot be used by bots`

**Cause:** somewhere, a `chat_id` reached kurigram as a **numeric string**
(e.g. `"-1001234567890"` or `"123456789"`) instead of an `int`, sent
through a **bot** client. kurigram's `Client.resolve_peer()` strips
`+()-` and whitespace from any string `chat_id`; if what's left is all
digits, it assumes the string is a phone number and calls
`contacts.ResolvePhone` — a raw Telegram method bot accounts cannot call
at all.

This is an extremely easy mistake to make without noticing, because chat
ids get stringified constantly for other purposes (dict keys, database
columns, `str(message.chat.id)` for logging) and then get reused as-is for
an actual API call.

**Fix, if you're calling richpyro directly:** you don't need to do
anything — `send()`/`edit()`/`reply()` already auto-convert a numeric
`chat_id` string to `int` before it reaches kurigram. If you're still
seeing this error, check whether you're calling a *raw* kurigram method
(`client.send_message(...)`, `client.copy_message(...)`, etc.) somewhere
with a stringified chat id instead of going through richpyro — that call
site is unprotected.

```python
# risky — resolve_peer will misread this as a phone number:
await client.send_message(str(chat.id), "hi")

# safe:
await rp.quick(client, chat.id, "hi")            # int, or richpyro fixes a string too
await rp.quick(client, str(chat.id), "hi")        # also safe — richpyro auto-int-ifies it
```

**Also watch for this same bug in `copy_message`.** `Client.copy_message()`
internally re-fetches the source message via `get_messages(chat_id=from_chat_id, ...)`
and separately resolves the *destination* `chat_id` — both ends are
vulnerable to the same string-vs-int issue independently. Pass real `int`
chat ids (or route through richpyro) on both sides.

## `[400 PHONE_NOT_OCCUPIED] - No user is associated to the specified phone number`

**Cause:** the same numeric-string misdetection as above, but hit from a
**user account** client instead of a bot. A user account *can* call
`contacts.ResolvePhone` (that's what it's for), so instead of
`BOT_METHOD_INVALID` you get a "phone number not found" error — because
the digits kurigram extracted from your chat id string aren't actually
anyone's registered phone number.

**Fix:** identical to above — pass an `int` chat id, or let richpyro's
`send()`/`edit()`/`reply()` auto-convert a string one.

## My rich card sent fine but the recipient says they saw nothing / saw plain text

**Cause:** the client you sent with is a **user account**, not a bot.
Telegram only renders Rich Messages for bots — see
[08-plain-text-fallback.md](08-plain-text-fallback.md). This isn't a bug,
it's richpyro's automatic degrade doing its job (a plain-text message
should have arrived instead) — if literally *nothing* arrived, check for
an exception being swallowed somewhere in your own error handling, since
`send()`'s fallback path always sends *something*.

**Fix:** if you specifically need Rich Message rendering (blocks, tables,
photos-in-cards, etc.), it has to go out through a bot client. Use a user
account only for things a bot can't do (joining chats it wasn't invited
to, reading full chat history, etc.) and hand off to a bot client for the
actual rich sending.

## My button doesn't do anything when tapped

Checklist, in order:

1. **Is there an `@app.on_callback_query(...)` handler registered at all?**
   A button with `callback_data` set does nothing on its own — you need a
   handler. See [04-buttons-and-callbacks.md](04-buttons-and-callbacks.md).
2. **Does your `filters.regex(...)` actually match the `callback_data` you
   set in `rp.btn(...)`?** A common typo is a mismatched prefix between
   `rp.btn("X", "confirm_yes")` and `filters.regex("^confirm_no")`.
3. **Is `callback_data` under 64 bytes?** Telegram silently rejects
   buttons whose `callback_data` is too long at send time in some clients,
   or truncates unpredictably — keep it short and look up longer state
   server-side by a short id instead.
4. **Did you forget `await callback_query.answer()`?** The tap likely
   *did* reach your handler — check your handler isn't raising an
   exception before reaching your logic (which would also leave the
   button's loading spinner stuck).

## `AssertionError` from `rp.buttons(...)`

```
AssertionError: a button row holds 1-8 buttons
```

**Cause:** you called `rp.buttons()` with zero buttons, or more than 8.
Telegram itself limits a single button row; split extra buttons across
multiple `rp.buttons(...)` rows inside the same `rp.message(...)` instead.

## `ValueError: You must provide either blocks, markdown or html in the rich message`

**Cause:** you constructed `rp.message()`/`rp.blocks_message()` with no
blocks at all, or built `rp.html_message()`/`rp.markdown_message()` with an
empty string. A rich message needs at least one form of content.

## Still stuck?

Open an issue: https://github.com/devgaganin/richpyro/issues
