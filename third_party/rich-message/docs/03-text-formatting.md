# Text formatting

Every function here builds a `RichText` node. You use these **inside**
blocks — most commonly inside `rp.para(...)` — never on their own.

## The `RichTextArg` rule

Anywhere a function below takes "text", you can pass:

1. **A plain string** — `"hello"`
2. **A list mixing strings and other formatting calls** — `["Hello ", rp.bold("World"), "!"]`
3. **A single nested formatting call** — `rp.bold(rp.italic("both"))`

`rp.para()` itself follows this same rule and additionally accepts each
part as a separate positional argument instead of one list, which is the
form you'll use most:

```python
rp.para("Hello ", rp.bold("World"), "! ", rp.italic("Nice to meet you."))
```

is equivalent to:

```python
rp.para(["Hello ", rp.bold("World"), "! ", rp.italic("Nice to meet you.")])
```

Nesting works everywhere: `rp.bold(rp.link("click", "https://x.com"))` gives
you bold, clickable text.

## Basic styles

| Function | Renders as |
|---|---|
| `rp.bold(text)` | **bold** |
| `rp.italic(text)` | *italic* |
| `rp.underline(text)` | underline |
| `rp.strike(text)` | ~~strikethrough~~ |
| `rp.spoiler(text)` | blurred "tap to reveal" spoiler |
| `rp.code(text)` | `inline monospace` |
| `rp.subscript(text)` | subscript |
| `rp.superscript(text)` | superscript |
| `rp.marked(text)` | highlighter-style marked text |

```python
rp.para(rp.bold("Total: "), rp.code("₹499"), " ", rp.strike("₹999"))
```

## Links and mentions

```python
rp.link("Docs", "https://docs.pyrogram.org")                 # clickable hyperlink
rp.mention("the admin", "channel_username")                  # by @username
rp.user_mention("Ramu", some_user_object)                    # by User object — works even without a username
rp.custom_emoji(custom_emoji_id="5xxxxxxxxx", alternative_text="🔥")  # premium custom emoji
```

`user_mention` needs an actual `types.User` object (e.g.
`message.from_user`), not just an id — that's the only way Telegram can
render a name for someone without a public `@username`.

## Structured inline data

These aren't just styling — Telegram recognizes them as specific data types
and may offer extra behavior (copy-to-clipboard, click-to-call, etc.)
depending on the client:

```python
rp.hashtag("#deals", "deals")
rp.bot_command("/start", "start")
rp.phone_number("+91 90000 00000", "+919000000000")
rp.email("support@example.com", "support@example.com")
rp.cashtag("$AAPL", "AAPL")
rp.bank_card("**** 4242", "4242424242424242")
```

## Dates

```python
from datetime import datetime
rp.date_time("tomorrow at 5pm", datetime(2026, 9, 19, 17, 0))
rp.date_time("tomorrow at 5pm", datetime(2026, 9, 19, 17, 0), fmt="%d %b %Y, %I:%M %p")
```

## Math

Inline, in the middle of a sentence:

```python
rp.para("The formula is ", rp.math_inline(r"x^2 + y^2 = z^2"), ".")
```

For a standalone, centered expression as its own block, use
`rp.math_block(...)` instead — see [05-blocks.md](05-blocks.md).

## Anchors and footnotes (jump links within one message)

```python
rp.para(rp.anchor_target("Section 1", name="s1"), " — intro text here.")
...
rp.para("See ", rp.anchor_link("Section 1", anchor_name="s1"), " above.")
```

```python
rp.para("Rates vary by region", rp.footnote_ref("¹", name="note1"), ".")
...
rp.para(rp.footnote_link("¹", reference_name="note1"), " Prices shown in INR.")
```

## An inline button, mid-sentence

Most buttons belong in their own row (see
[04-buttons-and-callbacks.md](04-buttons-and-callbacks.md)), but you can
also drop one directly into running text:

```python
rp.para("Need help? ", rp.inline_button(rp.btn("Contact support", "help")))
```
