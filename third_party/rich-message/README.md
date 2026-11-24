# richpyro

A complete, easy-to-call wrapper around [kurigram](https://github.com/kurimuzon/kurigram)'s
**Rich Messages** (Telegram Bot API 10.1+ `InputRichMessage` / `InputRichBlock*` /
`RichText*`, plus `Client.send_rich_message`, `Message.edit_text(rich_message=...)`
and `Message.reply_rich`).

Every block type, every text style, every button type — one flat, documented
function per thing, plus a safe `send()` / `edit()` / `reply()` call surface
that handles two real Telegram/kurigram footguns automatically so you never
have to think about them.

```bash
pip install richpyro
```

📖 **Full documentation: [docs/README.md](docs/README.md)** — installation,
every text style, every block type, a complete buttons-and-callbacks guide
(where to pass `callback_data`, how to catch a tap, how to edit the message
afterwards), the full `send()`/`edit()`/`reply()` reference, a runnable
full bot example, and a troubleshooting page for real errors.

## Why

Rich Messages are powerful but the raw API is deep (~50 constructor types)
and has two sharp edges that fail silently in production:

1. **Rich Messages only render for bot accounts.** Send `rich_message=...`
   from a real user/userbot client (a logged-in session, not a bot token)
   and Telegram silently drops or rejects it — no visible error, your
   progress bar / status card just stops updating.
2. **A numeric-string `chat_id` looks like a phone number to kurigram.**
   `Client.resolve_peer()` strips `+()-` and whitespace from any string
   `chat_id`; if what's left is all digits, it assumes it's a phone number
   and calls `contacts.ResolvePhone` — a method **bot accounts cannot call
   at all** (`[400 BOT_METHOD_INVALID]`), and which fails with
   `PHONE_NOT_OCCUPIED` for user accounts too unless that string happens to
   be someone's real registered phone number. This bites silently any time
   a chat id is passed as `str(chat.id)` instead of `int` — an extremely
   easy mistake, since chat ids get stringified for DB keys/dict lookups
   all over a typical bot codebase and then get reused as-is for an API call.

`richpyro.send()` / `.edit()` / `.reply()` check `client.me.is_bot` and
auto-degrade to an equivalent plain-text message for user-account senders,
and auto-int-ify any numeric-string `chat_id` before it reaches kurigram
(`@usernames` pass through untouched). You get both fixes for free just by
using this library's call surface instead of the raw kurigram methods.

## Quick start

```python
import richpyro as rp

# simplest possible call — one line, works from a bot OR a user client:
await rp.quick(client, chat_id, "Processing your request...")

# a structured card with formatting + buttons:
card = rp.message(
    rp.para("Hello ", rp.bold(name), "! Choose a plan:"),
    rp.divider(),
    rp.para("● ", rp.bold("Day Plan"), " — ₹20 (24 hours)"),
    rp.buttons(
        rp.btn("Day Plan ₹20", "pay_day"),
        rp.url_btn("Learn more", "https://example.com"),
    ),
)
sent = await rp.send(client, chat_id, card)
...
await rp.edit(client, chat_id, sent.id, rp.text("Payment confirmed."))

# replying directly to an incoming message (uses its own client):
await rp.reply(message, card)
```

Every builder returns a plain kurigram object — you can always drop down to
raw `types.InputRichMessage(...)` etc. for anything this library doesn't
wrap yet. richpyro objects and raw kurigram objects mix freely; nothing here
subclasses kurigram, it only constructs.

## What's covered

**Text formatting** — `bold`, `italic`, `underline`, `strike`, `spoiler`,
`code`, `link`, `user_mention`, `mention`, `custom_emoji`, `hashtag`,
`bot_command`, `phone_number`, `email`, `cashtag`, `bank_card`, `date_time`,
`subscript`, `superscript`, `anchor_target`, `anchor_link`, `footnote_ref`,
`footnote_link`, `marked`, `math_inline`, `inline_button`.

**Buttons** — `btn` (callback), `url_btn`, `webapp_btn`, `login_btn`,
`switch_inline_btn`, `switch_inline_here_btn`, `switch_inline_chosen_btn`,
`copy_btn`, `disabled_btn`, plus `buttons(...)` to lay out a row and
`Style` (`DEFAULT` / `PRIMARY` / `DANGER` / `SUCCESS` / `LINK`).

**Blocks** — `para`, `heading`, `divider`, `footer`, `anchor_block`,
`photo_block`, `video_block`, `animation_block`, `audio_block`,
`document_block`, `voice_block` (with matching `*_media` input helpers and
`caption(...)`), `collage`, `slideshow`, `list_item` / `bullet_list`,
`table_cell` / `table`, `details`, `blockquote`, `expandable_quote`,
`pull_quote`, `preformatted`, `map_block`, `math_block`, `thinking`.

**Message assembly** — `message(*blocks)` (the main entry point),
`html_message`, `markdown_message`, `text(...)` (the single-line shortcut
for the common case).

**Safe send surface** — `send`, `edit`, `reply`, `quick`, `quick_edit`,
`is_bot_client`, and `flatten_message` (the plain-text renderer used
automatically for the bot → user-account fallback, also handy standalone
for logs/previews).

## Requirements

- Python 3.9+
- [Kurigram](https://pypi.org/project/Kurigram/) 2.2.26+ (the actively
  maintained Pyrogram fork with Rich Messages support — still `import pyrogram`)

## License

MIT — see [LICENSE](LICENSE).

## Author

coded by **devgagan** — [github.com/devgaganin](https://github.com/devgaganin)
