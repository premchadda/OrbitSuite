# Buttons and callbacks

This is the page to read if you're asking "where do I pass the callback
data, how do I catch the tap, how do I edit the message afterwards."

Buttons attached to a Rich Message work exactly like buttons attached to
any other Telegram message — a tap always produces the same
`CallbackQuery` update, handled the same way, regardless of whether the
message under the button was sent as plain text, classic
`InlineKeyboardMarkup`, or a Rich Message block. richpyro doesn't invent a
new callback mechanism; it just builds the button objects for you.

## Step 1 — build the button, choose its `callback_data`

```python
rp.btn("Confirm", "confirm_yes")
```

- First argument: the label shown on the button (any `RichTextArg` — see
  [03-text-formatting.md](03-text-formatting.md), though plain buttons
  almost always just use a plain string label).
- Second argument: `callback_data` — an arbitrary string (or bytes) **you
  choose**, up to **64 bytes**. This is the payload Telegram hands back to
  your bot the moment someone taps the button. It is never shown to the
  user. Encode whatever you need to identify the action — an id, a short
  command, JSON if it fits in 64 bytes, etc.

```python
rp.btn("Delete item #42", f"del_{item_id}")
rp.btn("Page 2", f"page_{chat_id}_2")
```

If you need more than 64 bytes of state, don't try to cram it into
`callback_data` — store the state server-side (a dict, a database row)
keyed by a short id, and put only that id in `callback_data`.

## Step 2 — lay the button(s) out in a row

```python
rp.buttons(rp.btn("Yes", "confirm_yes"), rp.btn("No", "confirm_no"))
```

`rp.buttons(*btns, align=None)` is **one row**, holding 1–8 buttons. For a
multi-row keyboard, call it multiple times inside `rp.message(...)`:

```python
card = rp.message(
    rp.para("Choose a plan:"),
    rp.buttons(rp.btn("Day ₹20", "pay_day"), rp.btn("Week ₹100", "pay_week")),
    rp.buttons(rp.btn("Month ₹300", "pay_month")),   # second row
)
```

## Step 3 — send it

```python
await rp.reply(message, card)
# or: await rp.send(client, chat_id, card)
```

The button is now live on the sent message. Nothing else to do on the
sending side — the *handling* side is a separate handler function.

## Step 4 — catch the tap with `@app.on_callback_query`

```python
from pyrogram import filters

@app.on_callback_query(filters.regex("^confirm_"))
async def on_confirm(client, callback_query):
    data = callback_query.data              # "confirm_yes" or "confirm_no" — exactly what you set in btn()
    await callback_query.answer()           # REQUIRED — see below
    ...
```

This is plain kurigram, not richpyro — richpyro builds the button, kurigram
delivers the tap. Your handler receives:

- `client` — the same `Client` instance the bot is running as. This is the
  `client` argument you pass into `rp.send()`/`rp.edit()` for anything you
  do in response to the tap.
- `callback_query` — a `CallbackQuery` object with:
  - `.data` — your `callback_data` string, back again.
  - `.message` — the `Message` the button was attached to (its `.chat.id`
    and `.id` are exactly what you need for `rp.edit()`).
  - `.from_user` — who tapped it.
  - `.answer(text=None, show_alert=False)` — see next section.

### Routing multiple button actions

Use `filters.regex(...)` (as above) to route different `callback_data`
prefixes to different handlers, or use one handler and branch on `.data`
yourself:

```python
@app.on_callback_query()
async def on_any_callback(client, callback_query):
    if callback_query.data.startswith("pay_"):
        plan = callback_query.data.removeprefix("pay_")
        ...
    elif callback_query.data.startswith("del_"):
        item_id = callback_query.data.removeprefix("del_")
        ...
```

## Step 5 — always call `.answer()`

Telegram shows a small loading spinner on a tapped button until your bot
calls `callback_query.answer(...)`. If you never call it, the spinner
eventually times out and the user sees nothing happened — every callback
handler should call `.answer()` near the start, even with no arguments:

```python
await callback_query.answer()                              # just stops the spinner
await callback_query.answer("Saved!")                        # small transient toast
await callback_query.answer("You must be an admin.", show_alert=True)  # blocking popup dialog
```

## Step 6 — update the message (usually: edit it)

The overwhelmingly common pattern is editing the same message the button
was attached to, using the chat/message id off `callback_query.message`:

```python
await rp.edit(
    client,
    callback_query.message.chat.id,
    callback_query.message.id,
    rp.text(f"You picked: {data}"),
)
```

This works identically to any other `rp.edit()` call — same client/bot
detection, same numeric-chat-id safety — see
[07-sending-editing-replying.md](07-sending-editing-replying.md).

You are not limited to editing — from a callback handler you can just as
well `rp.send()` a brand new message, delete the old one
(`await callback_query.message.delete()`), or both.

## Buttons that DON'T need a callback handler at all

Not every button in `rp.buttons(...)` goes through `on_callback_query`.
Three kinds are handled entirely client-side by Telegram and never reach
your bot:

```python
rp.url_btn("Visit site", "https://example.com")        # just opens the URL
rp.copy_btn("Copy code", "PROMO2026")                    # copies text to clipboard
rp.switch_inline_btn("Search", "query text")             # opens inline mode elsewhere
```

`webapp_btn(...)` is a middle case: tapping it opens your Mini App in an
overlay; if that app calls Telegram's `sendData()`, your bot receives it as
a **message update** (`message.web_app_data`), not a callback query — that
part is standard kurigram, outside richpyro's scope.

`login_btn(...)` triggers Telegram's Login Widget flow (no callback query
either — the result reaches you via the URL Telegram redirects to, per
your `login_url` configuration).

`disabled_btn(...)` is inert by design — a visual-only label, never
tappable, never dispatched anywhere.

## Full working example

See [09-full-example.md](09-full-example.md) for a complete, runnable bot
file putting all of this together: send → tap → answer → edit.
