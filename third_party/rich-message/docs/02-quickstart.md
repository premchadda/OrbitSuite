# Quickstart

Five functions cover almost everything you'll do with richpyro day to day:

| Function | Use it to... |
|---|---|
| `rp.quick(client, chat_id, text)` | Send a one-line plain message, the easy way |
| `rp.message(*blocks)` | Build a structured card (formatting + buttons) |
| `rp.send(client, chat_id, msg)` | Send that card |
| `rp.edit(client, chat_id, message_id, msg)` | Change an already-sent message |
| `rp.reply(message, msg)` | Reply to an incoming message, no need to look up the chat id yourself |

## 1. The simplest possible message

```python
await rp.quick(client, chat_id, "Processing your request...")
```

One line. No blocks to build. Works whether `client` is a bot or a user
account (see [08-plain-text-fallback.md](08-plain-text-fallback.md) for why
that matters). Internally this is exactly:

```python
await rp.send(client, chat_id, rp.text("Processing your request..."))
```

## 2. A structured card

```python
card = rp.message(
    rp.para("Hello ", rp.bold("World"), "! Choose a plan:"),
    rp.divider(),
    rp.para("● ", rp.bold("Day Plan"), " — ₹20 (24 hours)"),
    rp.buttons(
        rp.btn("Day Plan ₹20", "pay_day"),
        rp.url_btn("Learn more", "https://example.com"),
    ),
)
sent = await rp.send(client, chat_id, card)
```

`rp.message(*blocks)` takes any number of blocks — paragraphs, dividers,
photos, tables, button rows, whatever you need — see
[05-blocks.md](05-blocks.md) for the full catalogue. Blocks themselves are
built from formatted text — see [03-text-formatting.md](03-text-formatting.md).

`rp.send()` returns the sent `Message` object (same as kurigram's own
`send_message`/`send_rich_message` would), so `sent.id` is your message id
for later edits.

## 3. Editing that message later

```python
await rp.edit(client, chat_id, sent.id, rp.text("Payment confirmed."))
```

## 4. Replying to an incoming message directly

Inside a message handler, you already have the incoming `Message` object —
no need to dig out `chat_id` and pass a `client` separately:

```python
@app.on_message(filters.command("start"))
async def start(client, message):
    await rp.reply(message, rp.text("Welcome!"))
```

## 5. Buttons that do something when tapped

This is covered in full in
[04-buttons-and-callbacks.md](04-buttons-and-callbacks.md), but the shape is:

```python
rp.buttons(rp.btn("Confirm", "confirm_yes"))   # "confirm_yes" is your callback_data
```

```python
@app.on_callback_query(filters.regex("^confirm_yes$"))
async def on_confirm(client, callback_query):
    await callback_query.answer()
    await rp.edit(client, callback_query.message.chat.id, callback_query.message.id,
                   rp.text("Confirmed."))
```

Continue to [03-text-formatting.md](03-text-formatting.md) for every text
style, or jump straight to
[04-buttons-and-callbacks.md](04-buttons-and-callbacks.md) if buttons are
what you're here for.
