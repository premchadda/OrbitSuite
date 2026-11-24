# richpyro documentation

A complete, easy-to-call wrapper around kurigram's Rich Messages
(Telegram Bot API 10.1+). Start here, then jump to whichever page matches
what you're doing right now.

| Page | What's in it |
|---|---|
| [01-installation.md](01-installation.md) | `pip install`, requirements, importing |
| [02-quickstart.md](02-quickstart.md) | The five functions you'll use 90% of the time |
| [03-text-formatting.md](03-text-formatting.md) | bold/italic/links/mentions/math/... — every inline text style |
| [04-buttons-and-callbacks.md](04-buttons-and-callbacks.md) | **Buttons, `callback_data`, and how to handle button taps** — read this if you're asking "where do I pass the callback, how do I catch it, how do I edit the message after" |
| [05-blocks.md](05-blocks.md) | Paragraphs, photos, tables, lists, quotes, code blocks — every block type |
| [06-message-builders.md](06-message-builders.md) | Assembling blocks into a message; HTML/Markdown alternatives |
| [07-sending-editing-replying.md](07-sending-editing-replying.md) | **`send()` / `edit()` / `reply()` in full** — the `client` argument, `chat_id` handling, what happens for a bot vs. a user account |
| [08-plain-text-fallback.md](08-plain-text-fallback.md) | How the automatic bot/user degrade works, and `flatten_message()` |
| [09-full-example.md](09-full-example.md) | A complete, runnable bot: menu → button tap → edit → confirmation |
| [10-troubleshooting.md](10-troubleshooting.md) | `BOT_METHOD_INVALID`, `PHONE_NOT_OCCUPIED`, buttons that don't respond, and other real errors with real fixes |

## The one-paragraph version

```python
import richpyro as rp
from pyrogram import Client, filters

app = Client("mybot", bot_token="...")

@app.on_message(filters.command("start"))
async def start(client, message):
    card = rp.message(
        rp.para("Pick one:"),
        rp.buttons(rp.btn("Yes", "confirm_yes"), rp.btn("No", "confirm_no")),
    )
    await rp.reply(message, card)                     # client comes from the handler automatically

@app.on_callback_query(filters.regex("^confirm_"))
async def on_confirm(client, callback_query):
    choice = callback_query.data                       # "confirm_yes" or "confirm_no"
    await callback_query.answer()                       # stop the button's loading spinner
    await rp.edit(                                       # edit the SAME message in place
        client, callback_query.message.chat.id, callback_query.message.id,
        rp.text(f"You picked: {choice}"),
    )

app.run()
```

Full breakdown of every piece of this in
[04-buttons-and-callbacks.md](04-buttons-and-callbacks.md) and
[09-full-example.md](09-full-example.md).
