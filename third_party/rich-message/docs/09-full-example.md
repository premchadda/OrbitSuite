# Full example

A complete, runnable bot showing the whole flow end to end: a card with
buttons, both button-tap handling patterns, editing in place, and a plain
`/start` command. Save as `bot.py`, fill in your credentials, run it.

```python
from pyrogram import Client, filters
import richpyro as rp

app = Client(
    "mybot",
    api_id=YOUR_API_ID,
    api_hash="YOUR_API_HASH",
    bot_token="YOUR_BOT_TOKEN",
)


# ── /start — a structured card with two rows of buttons ──────────────
@app.on_message(filters.command("start"))
async def start(client, message):
    card = rp.message(
        rp.para("Hello ", rp.bold(message.from_user.first_name), "!"),
        rp.divider(),
        rp.para("Choose a plan:"),
        rp.buttons(
            rp.btn("Day — ₹20", "plan_day"),
            rp.btn("Week — ₹100", "plan_week"),
        ),
        rp.buttons(
            rp.url_btn("Terms", "https://example.com/terms"),
        ),
        rp.footer(rp.italic("Powered by richpyro")),
    )
    await rp.reply(message, card)


# ── button taps for "plan_*" — edit the same card into a confirmation ─
@app.on_callback_query(filters.regex("^plan_"))
async def on_plan_chosen(client, callback_query):
    plan = callback_query.data.removeprefix("plan_")   # "day" or "week"

    # Always answer first — stops the button's loading spinner.
    await callback_query.answer(f"{plan.title()} plan selected")

    confirm_card = rp.message(
        rp.para("✓ ", rp.bold(f"{plan.title()} plan"), " selected."),
        rp.divider(),
        rp.para("Tap below to pay."),
        rp.buttons(rp.btn("Pay now", f"pay_{plan}")),
    )
    await rp.edit(
        client,
        callback_query.message.chat.id,
        callback_query.message.id,
        confirm_card,
    )


# ── button taps for "pay_*" — a second edit, simulating a payment step ─
@app.on_callback_query(filters.regex("^pay_"))
async def on_pay(client, callback_query):
    plan = callback_query.data.removeprefix("pay_")
    await callback_query.answer("Processing...", show_alert=False)

    # ... call your real payment provider here ...

    await rp.edit(
        client,
        callback_query.message.chat.id,
        callback_query.message.id,
        rp.text(f"✓ Payment received for the {plan} plan. Thanks!"),
    )


# ── a plain one-off status message, no card needed ────────────────────
@app.on_message(filters.command("ping"))
async def ping(client, message):
    await rp.reply(message, rp.text("pong"))


app.run()
```

## What to notice

- `start()` never touches `chat_id` directly — `rp.reply(message, card)`
  works it out from the incoming `Message`.
- `on_plan_chosen()` and `on_pay()` both get `client` as their first
  handler argument (standard kurigram) and reuse it for `rp.edit()` — you
  never construct a second `Client` or look one up.
- Both callback handlers call `.answer()` **before** doing any slow work
  (or immediately, with a message) — never after, and never skipped.
- `callback_query.message.chat.id` / `callback_query.message.id` are
  always the right pair to hand `rp.edit()` when you want to update the
  exact message the button lives on.
- This bot only ever runs as a bot account, so the plain-text fallback
  described in [08-plain-text-fallback.md](08-plain-text-fallback.md) never
  triggers here — but every `rp.send`/`rp.edit`/`rp.reply` call above would
  behave correctly unmodified even if `app` were a user-account `Client`
  instead of a bot.
