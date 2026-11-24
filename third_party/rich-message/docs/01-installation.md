# Installation

```bash
pip install richpyro
```

## Requirements

- Python 3.9+
- [Kurigram](https://pypi.org/project/Kurigram/) 2.2.26+ — the actively
  maintained Pyrogram fork (still `import pyrogram`) that added Rich
  Messages support (Bot API 10.1+). Plain upstream Pyrogram does **not**
  have `Client.send_rich_message` / `types.InputRichMessage` / etc., so
  richpyro needs Kurigram specifically, not just "any Pyrogram-like library."

If you already depend on `pyrogram` in your project and it's actually
Kurigram under the hood, you're fine — `pip install richpyro` pulls in
`Kurigram>=2.2.26` as a dependency automatically if it's missing.

## Importing

```python
import richpyro as rp
```

Everything in this documentation assumes that import alias (`rp`). There is
no submodule structure to worry about — every builder, every send/edit
function, everything is a flat top-level name on the package:

```python
rp.bold(...)
rp.btn(...)
rp.para(...)
rp.message(...)
rp.send(...)
```

You can also import individual names directly if you prefer:

```python
from richpyro import message, para, bold, btn, buttons, send
```

## Do you need a bot token?

richpyro works with **both** a bot client (`bot_token="..."`) and a user
client (a logged-in session via `Client("name", api_id=..., api_hash=...)`
+ phone login, no bot token). You don't have to choose ahead of time —
`send()`/`edit()`/`reply()` detect which kind of client you passed at call
time and behave correctly either way. See
[07-sending-editing-replying.md](07-sending-editing-replying.md) for exactly
what "behave correctly either way" means.
