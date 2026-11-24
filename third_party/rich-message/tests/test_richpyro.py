"""Basic coverage for richpyro's builders and its send/edit/reply safety
wrappers, using tiny fake Client/Message stand-ins instead of a live
Telegram connection."""
import asyncio

import pytest
from pyrogram import types

import richpyro as rp


class FakeUser:
    def __init__(self, is_bot: bool):
        self.is_bot = is_bot


class FakeClient:
    """Records every call instead of hitting the network."""

    def __init__(self, is_bot: bool):
        self.me = FakeUser(is_bot)
        self.calls = []

    async def send_rich_message(self, chat_id, **kw):
        self.calls.append(("rich", chat_id, kw))
        return "rich_sent"

    async def send_message(self, chat_id, text, **kw):
        self.calls.append(("plain", chat_id, text, kw))
        return "plain_sent"

    async def edit_message_text(self, chat_id, message_id, *args, **kw):
        self.calls.append(("edit", chat_id, message_id, args, kw))
        return "edited"


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


# ── builders ────────────────────────────────────────────────────────
def test_text_formatting_builders_return_correct_types():
    assert isinstance(rp.bold("x"), types.RichTextBold)
    assert isinstance(rp.italic("x"), types.RichTextItalic)
    assert isinstance(rp.link("x", "https://example.com"), types.RichTextUrl)
    assert isinstance(rp.code("x"), types.RichTextCode)


def test_para_accepts_single_and_multiple_parts():
    single = rp.para("just text")
    assert single.text == "just text"

    multi = rp.para("Hello ", rp.bold("World"), "!")
    assert isinstance(multi.text, list)
    assert len(multi.text) == 3


def test_buttons_row_enforces_1_to_8():
    row = rp.buttons(rp.btn("A", "a"), rp.url_btn("B", "https://example.com"))
    assert isinstance(row, types.InputRichBlockButtons)
    assert len(row.buttons) == 2

    with pytest.raises(AssertionError):
        rp.buttons()


def test_message_and_text_shortcut():
    card = rp.message(rp.para("hi"), rp.divider())
    assert isinstance(card, types.InputRichMessage)
    assert len(card.blocks) == 2

    quick_msg = rp.text("hello there")
    assert isinstance(quick_msg, types.InputRichMessage)
    assert quick_msg.blocks[0].text == "hello there"


# ── plain-text fallback rendering ──────────────────────────────────
def test_flatten_message_renders_formatting_and_structure():
    card = rp.message(
        rp.para("Hello ", rp.bold("World")),
        rp.divider(),
        rp.para(rp.code("x = 1")),
    )
    flat = rp.flatten_message(card)
    assert "**World**" in flat
    assert "`x = 1`" in flat


# ── send / edit safety wrappers ────────────────────────────────────
def test_send_uses_rich_message_for_bot_client():
    bot = FakeClient(is_bot=True)
    run(rp.send(bot, "-1001234567890", rp.text("hi")))
    kind, chat_id, _ = bot.calls[-1]
    assert kind == "rich"
    assert chat_id == -1001234567890  # int-ified
    assert isinstance(chat_id, int)


def test_send_degrades_to_plain_text_for_user_client():
    user = FakeClient(is_bot=False)
    run(rp.send(user, "123456789", rp.text("hi")))
    kind, chat_id, text, _ = user.calls[-1]
    assert kind == "plain"
    assert chat_id == 123456789
    assert isinstance(chat_id, int)
    assert text == "hi"


def test_username_chat_id_passes_through_untouched():
    bot = FakeClient(is_bot=True)
    run(rp.send(bot, "@somechannel", rp.text("hi")))
    _, chat_id, _ = bot.calls[-1]
    assert chat_id == "@somechannel"


def test_quick_and_quick_edit_shortcuts():
    user = FakeClient(is_bot=False)
    run(rp.quick(user, "999", "hi"))
    assert user.calls[-1][:3] == ("plain", 999, "hi")

    bot = FakeClient(is_bot=True)
    run(rp.quick_edit(bot, "-100555", 42, "edited"))
    kind, chat_id, message_id, _, kw = bot.calls[-1]
    assert (kind, chat_id, message_id) == ("edit", -100555, 42)
    assert isinstance(kw["rich_message"], types.InputRichMessage)
