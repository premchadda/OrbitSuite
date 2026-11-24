# The plain-text fallback (and why it exists)

## Why a fallback is needed at all

Telegram only renders Rich Messages (`rich_message=...`) for **bot**
accounts. If you send one from a real user/userbot client (a logged-in
session, not a bot token), Telegram silently drops or rejects it — nothing
crashes, nothing shows an error, the message you asked for just never
appears, or appears empty. This is a real production behavior, not a
theoretical edge case — it's the reason `send()`/`edit()`/`reply()` check
`client.me.is_bot` on every call and branch accordingly (see
[07-sending-editing-replying.md](07-sending-editing-replying.md)).

## What "falling back" actually sends

When `client` is a user account, richpyro sends an ordinary
`client.send_message(chat_id, text, ...)` instead of
`client.send_rich_message(...)`. The `text` comes from one of two places:

1. **Your own `fallback_text=` argument**, if you passed one — always
   preferred when present.
2. **`flatten_message(msg)`**, richpyro's automatic best-effort renderer,
   otherwise.

## `flatten_message()` — what it produces

```python
card = rp.message(
    rp.para("Hello ", rp.bold("World")),
    rp.divider(),
    rp.para(rp.code("x = 1")),
)
rp.flatten_message(card)
```

```
Hello **World**
───────────
`x = 1`
```

Formatting-only nodes degrade to Pyrogram's own Markdown syntax
(`**bold**`, `__italic__`, `` `code` ``, etc.) so *some* formatting still
shows in the plain fallback rather than being silently dropped. Structural
blocks with no real plain-text equivalent (a photo, a table, a map, a
collage...) degrade to a short bracketed label like `[Photo]` or
`[Table]` so you at least know something was there, rather than the block
vanishing with no trace.

You can call `flatten_message()` yourself any time you want a plain-text
preview of a card — for logs, for an admin notification channel that
doesn't use Rich Messages, or anywhere else a quick plain rendering is
useful, independent of actually sending anything.

## When to write your own `fallback_text`

The auto-flatten is a safety net, not a design tool. Write your own
`fallback_text=` whenever:

- The card leans on visual structure the flatten can't represent well (a
  table, a multi-photo collage, a map).
- You want a genuinely different (usually shorter) message for
  user-account recipients rather than a literal transcript of the rich
  version.
- Buttons matter — button labels flatten to `[Label]` text with no way to
  tap them; if the action needs to survive without Rich Messages, pass a
  classic `reply_markup=InlineKeyboardMarkup(...)` instead (works on both
  the bot and the user-account code path — see
  [07-sending-editing-replying.md](07-sending-editing-replying.md)).

```python
await rp.send(
    client, chat_id, card,
    fallback_text="New order — check the bot for details.",
)
```

## Skipping the check entirely

If you already know for certain which kind of client you're calling with
(for example, inside a loop where you've already confirmed it once), pass
`is_bot=True`/`is_bot=False` to skip the `client.me` lookup:

```python
await rp.send(client, chat_id, card, is_bot=True)
```

This is a minor performance optimization only — `is_bot_client()` reads a
cached attribute (`client.me`) under normal circumstances, so the check
itself is cheap; skip it only if you're sending at high volume and want to
shave off even that.
