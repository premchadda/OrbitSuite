# Sending, editing, replying — the full reference

This page explains every argument of `send()`, `edit()`, `reply()`,
`quick()` and `quick_edit()` — what `client` needs to be, what `chat_id`
can be, and exactly what happens differently for a bot account vs. a user
account.

## `send()`

```python
async def send(
    client, chat_id, msg,
    *,
    fallback_text=None,
    is_bot=None,
    reply_markup=None,
    disable_notification=None,
    reply_parameters=None,
    effect_id=None,
)
```

| Argument | What to pass |
|---|---|
| `client` | A **connected, started** `pyrogram.Client` — either a bot (`Client(..., bot_token="...")`) or a logged-in user session. This is always the client whose identity the message will be sent *as*. In a message handler it's the first argument your handler receives (`async def handler(client, message)`); outside a handler, it's whatever `Client` object you `.start()`ed yourself. |
| `chat_id` | Where to send it. Any of: an `int` chat id (`-1001234567890`, `123456789`), a `str` chat id (`"-1001234567890"` — see the note below), or a `"@username"` string. |
| `msg` | An `InputRichMessage` — the output of `rp.message(...)`, `rp.text(...)`, `rp.html_message(...)`, or `rp.markdown_message(...)`. |
| `fallback_text` | Optional. The plain-text version to send if `client` turns out to be a user account (see [08-plain-text-fallback.md](08-plain-text-fallback.md)). If you don't pass this, richpyro generates one automatically from `msg`'s blocks. Pass your own whenever the auto-generated version wouldn't read well (e.g. a card with a table or a photo — plain-text can't really represent those). |
| `is_bot` | Optional `True`/`False`. Skip this unless you already know whether `client` is a bot and want to avoid the (cheap, cached) check richpyro does internally — useful in a tight loop sending hundreds of messages back to back. |
| `reply_markup` | Optional — pass a classic `InlineKeyboardMarkup`/`ReplyKeyboardMarkup`/etc. if you want a *non-rich* keyboard alongside/instead of button blocks inside `msg` itself. Most of the time you don't need this — put buttons inside the message with `rp.buttons(...)` instead (see [04-buttons-and-callbacks.md](04-buttons-and-callbacks.md)). |
| `disable_notification` | `True` to send silently (no notification sound for the recipient). |
| `reply_parameters` | Optional `types.ReplyParameters` if you're manually constructing a reply-to-message-id relationship outside of using `rp.reply()`. |
| `effect_id` | Optional message effect id (private chats only) — same as kurigram's own `send_rich_message`. |

Returns the sent `Message` object (whether it actually went out as
`send_rich_message` or degraded to `send_message` — see below — the return
type is the same `Message` either way, so your calling code doesn't need
to branch on it).

### What actually happens inside `send()`

1. `chat_id` is passed through `_safe_chat_id()` — if it's a numeric
   string (with or without a leading `-`), it's converted to `int`.
   `"@username"` strings are left untouched. **Why:** kurigram's
   `resolve_peer()` treats any all-digit string as a phone number and
   calls a Telegram method (`contacts.ResolvePhone`) that bot accounts
   cannot call at all — a numeric-string `chat_id` reliably breaks bot
   sends with `[400 BOT_METHOD_INVALID]`, and breaks user-account sends
   too unless that exact string happens to be someone's real phone
   number. See [10-troubleshooting.md](10-troubleshooting.md) for the full
   story — this is a real bug this library exists specifically to prevent.
2. richpyro checks whether `client` is a bot account (`client.me.is_bot`,
   or your `is_bot=` override).
3. **If it's a bot:** calls `client.send_rich_message(chat_id, rich_message=msg, ...)` —
   your card renders exactly as built, with all its blocks and buttons.
4. **If it's a user account:** Rich Messages don't render for user
   accounts at all (Telegram silently drops them) — so richpyro instead
   calls `client.send_message(chat_id, fallback_text_or_flattened, ...)`,
   sending an equivalent plain-text message instead. Buttons inside `msg`'s
   blocks do **not** carry over to this plain-text fallback — if you need
   buttons to work from a user-account sender too, pass them via
   `reply_markup=` explicitly (a classic `InlineKeyboardMarkup`), since
   that parameter is honored on both code paths.

## `edit()`

```python
async def edit(client, chat_id, message_id, msg, *, fallback_text=None, is_bot=None, reply_markup=None)
```

Same `client`/`chat_id`/`msg`/`fallback_text`/`is_bot` as `send()`.
`message_id` is the id of the message you're changing — typically
`sent.id` from an earlier `send()`/`reply()` call, or
`callback_query.message.id` inside a button handler.

```python
sent = await rp.send(client, chat_id, rp.text("Working..."))
# ... do some work ...
await rp.edit(client, chat_id, sent.id, rp.text("Done."))
```

Internally this is the same bot/user branch as `send()`, just calling
`client.edit_message_text(chat_id, message_id, rich_message=msg, ...)` for
a bot, or a plain-text `edit_message_text(chat_id, message_id, text, ...)`
for a user account.

## `reply()`

```python
async def reply(message_obj, msg, *, fallback_text=None, is_bot=None, reply_markup=None, disable_notification=None)
```

`message_obj` is an incoming `Message` (the one your handler received).
`reply()` pulls the client and chat automatically from it — you never pass
`client` or `chat_id` yourself:

```python
@app.on_message(filters.command("start"))
async def start(client, message):
    await rp.reply(message, rp.text("Welcome!"))
```

This works because kurigram's own `Message` objects carry a reference to
the client that received them; `reply()` uses that same reference
(`message_obj._client`) the way `message.reply_text()`/`message.reply_rich()`
do internally.

## `quick()` / `quick_edit()`

```python
async def quick(client, chat_id, plain_text, **kw)
async def quick_edit(client, chat_id, message_id, plain_text, **kw)
```

The single-line shortcuts from [02-quickstart.md](02-quickstart.md).
Exactly `send(client, chat_id, rp.text(plain_text), fallback_text=plain_text, **kw)`
(and the `edit()` equivalent) — same `client`/`chat_id` rules as above,
same `**kw` passthrough for `reply_markup`/`disable_notification`/etc.

## `is_bot_client()`

```python
bot = await rp.is_bot_client(client)   # True / False
```

The check `send()`/`edit()`/`reply()` run internally, exposed standalone in
case you want to branch on it yourself for something richpyro doesn't
cover. Uses `client.me` (cached after `Client.start()`), fetching it once
via `client.get_me()` if it isn't cached yet.
