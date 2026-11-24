"""
richpyro — a complete, easy-to-call wrapper around kurigram's Rich Messages
(Bot API 10.1+ InputRichMessage / InputRichBlock* / RichText* / raw
Client.send_rich_message / Message.edit_text(rich_message=...) / Message.reply_rich).

coded by devgagan — https://github.com/devgaganin

────────────────────────────────────────────────────────────────────────
WHY THIS EXISTS (read this before using rich messages anywhere)
────────────────────────────────────────────────────────────────────────
Two real production bugs, both discovered live on this project, are baked
into this library as automatic protections so nobody hits them again:

1. RICH MESSAGES ARE BOT-ONLY.
   Telegram only renders `rich_message=...` for a BOT account. Send it
   from a real user/userbot client (a logged-in session, not a bot
   token) and Telegram silently drops/rejects it — progress bars, status
   cards, everything just stops updating with no visible error.
   Fix baked in here: every send/edit/reply call in this library checks
   `client.me.is_bot` and automatically falls back to a plain text
   message with equivalent content when the client isn't a bot. You
   never have to remember to branch on this yourself.

2. A NUMERIC-STRING chat_id LOOKS LIKE A PHONE NUMBER TO kurigram.
   `Client.resolve_peer()` takes any string chat_id, strips `+()-` and
   whitespace, and if what's left is all digits it assumes it's a phone
   number and calls `contacts.ResolvePhone` — a method BOT ACCOUNTS
   CANNOT CALL AT ALL (`[400 BOT_METHOD_INVALID]`), and which fails with
   `PHONE_NOT_OCCUPIED` for user accounts too unless that literal string
   happens to be someone's real registered phone number. This bites
   silently any time a chat_id is passed as `str(chat.id)` instead of
   `int` — which is an extremely easy mistake since Telegram chat IDs
   are commonly stringified for DB storage/dict keys elsewhere in a
   codebase and then reused as-is for an API call.
   Fix baked in here: every chat_id passed through this library is
   auto-int-ified (`"-1001234567890"` -> `-1001234567890`) before it
   ever reaches kurigram. Usernames/`@handles` pass through untouched.

────────────────────────────────────────────────────────────────────────
INSTALL
────────────────────────────────────────────────────────────────────────
    pip install richpyro

Requires Kurigram (the actively-maintained Pyrogram fork, `import pyrogram`
still works) — richpyro builds on its Rich Messages support (Bot API
10.1+). Plain Pyrogram/Pyrofork installs without Rich Messages will import
fine but the send()/edit()/reply() wrappers need the raw types this
library constructs.

────────────────────────────────────────────────────────────────────────
QUICK START
────────────────────────────────────────────────────────────────────────
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

Every builder below returns a plain kurigram object — you can always drop
down to raw `types.InputRichMessage(...)` etc. if you need something this
library doesn't wrap yet; richpyro objects and raw kurigram objects mix
freely since richpyro never subclasses anything, it only constructs.
"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Iterable, Union

from pyrogram import enums, types

__version__ = "0.1.0"
__author__ = "devgagan"
__all__ = [
    # text formatting
    "bold", "italic", "underline", "strike", "spoiler", "code", "link",
    "user_mention", "mention", "custom_emoji", "hashtag", "bot_command",
    "phone_number", "email", "cashtag", "bank_card", "date_time",
    "subscript", "superscript", "anchor_target", "anchor_link",
    "footnote_ref", "footnote_link", "marked", "math_inline", "inline_button",
    # buttons
    "Style", "btn", "url_btn", "webapp_btn", "login_btn", "switch_inline_btn",
    "switch_inline_here_btn", "switch_inline_chosen_btn", "copy_btn",
    "disabled_btn", "buttons",
    # media
    "photo_media", "video_media", "animation_media", "audio_media",
    "document_media", "voice_media", "caption", "named_media",
    # blocks
    "para", "heading", "divider", "footer", "anchor_block", "photo_block",
    "video_block", "animation_block", "audio_block", "document_block",
    "voice_block", "collage", "slideshow", "list_item", "bullet_list",
    "table_cell", "table", "details", "blockquote", "expandable_quote",
    "pull_quote", "preformatted", "map_block", "math_block", "thinking",
    # message builders
    "message", "blocks_message", "html_message", "markdown_message",
    "text", "text_message",
    # plain-text fallback rendering
    "flatten_message",
    # send / edit / reply
    "is_bot_client", "send", "edit", "reply", "quick", "quick_edit",
]

# A "rich text" argument anywhere in this module accepts: a plain str, a
# list mixing str/RichText parts (auto-concatenated), or a single RichText
# node (bold(...), italic(...), etc. — nest freely, e.g. bold(italic("x"))).
RichTextArg = Union[str, list, "types.RichText"]


# ════════════════════════════════════════════════════════════════════
#  TEXT FORMATTING  (wraps every RichText* input type)
# ════════════════════════════════════════════════════════════════════
def bold(text: RichTextArg) -> types.RichTextBold:
    return types.RichTextBold(text=text)


def italic(text: RichTextArg) -> types.RichTextItalic:
    return types.RichTextItalic(text=text)


def underline(text: RichTextArg) -> types.RichTextUnderline:
    return types.RichTextUnderline(text=text)


def strike(text: RichTextArg) -> types.RichTextStrikethrough:
    return types.RichTextStrikethrough(text=text)


def spoiler(text: RichTextArg) -> types.RichTextSpoiler:
    return types.RichTextSpoiler(text=text)


def code(text: RichTextArg) -> types.RichTextCode:
    """Inline monospace code (for a full code block use `preformatted()`)."""
    return types.RichTextCode(text=text)


def link(text: RichTextArg, url: str) -> types.RichTextUrl:
    """A clickable text hyperlink: link("Docs", "https://docs.pyrogram.org")."""
    return types.RichTextUrl(text=text, url=url)


def user_mention(text: RichTextArg, user: "types.User") -> types.RichTextTextMention:
    """Mention a user by their User object — works even if they have no
    @username (unlike `mention()` below)."""
    return types.RichTextTextMention(text=text, user=user)


def mention(text: RichTextArg, username: str) -> types.RichTextMention:
    """Mention a user/channel by @username string."""
    return types.RichTextMention(text=text, username=username)


def custom_emoji(custom_emoji_id: str, alternative_text: str) -> types.RichTextCustomEmoji:
    """A premium custom emoji. `alternative_text` is what non-premium
    clients / plain-text fallback show instead (e.g. the matching plain emoji)."""
    return types.RichTextCustomEmoji(custom_emoji_id=custom_emoji_id, alternative_text=alternative_text)


def hashtag(text: RichTextArg, tag: str) -> types.RichTextHashtag:
    return types.RichTextHashtag(text=text, hashtag=tag)


def bot_command(text: RichTextArg, command: str) -> types.RichTextBotCommand:
    return types.RichTextBotCommand(text=text, bot_command=command)


def phone_number(text: RichTextArg, number: str) -> types.RichTextPhoneNumber:
    return types.RichTextPhoneNumber(text=text, phone_number=number)


def email(text: RichTextArg, address: str) -> types.RichTextEmailAddress:
    return types.RichTextEmailAddress(text=text, email_address=address)


def cashtag(text: RichTextArg, tag: str) -> types.RichTextCashtag:
    return types.RichTextCashtag(text=text, cashtag=tag)


def bank_card(text: RichTextArg, number: str) -> types.RichTextBankCardNumber:
    return types.RichTextBankCardNumber(text=text, bank_card_number=number)


def date_time(text: RichTextArg, date: datetime, fmt: str | None = None) -> types.RichTextDateTime:
    """`fmt` is an optional display format string; omit to use Telegram's default."""
    return types.RichTextDateTime(text=text, date=date, date_time_format=fmt)


def subscript(text: RichTextArg) -> types.RichTextSubscript:
    return types.RichTextSubscript(text=text)


def superscript(text: RichTextArg) -> types.RichTextSuperscript:
    return types.RichTextSuperscript(text=text)


def anchor_target(text: RichTextArg, name: str) -> types.RichTextAnchor:
    """Marks `text` as a named jump-target (`name`) that `anchor_link()`
    or `anchor_block()` can jump to within the same rich message."""
    return types.RichTextAnchor(text=text, name=name)


def anchor_link(text: RichTextArg, anchor_name: str) -> types.RichTextAnchorLink:
    """A clickable link that jumps to a target defined by `anchor_target()`
    or `anchor_block()` with the same name."""
    return types.RichTextAnchorLink(text=text, anchor_name=anchor_name)


def footnote_ref(text: RichTextArg, name: str) -> types.RichTextReference:
    """Superscript footnote marker — pair with `footnote_link()` elsewhere
    in the message to link back to this reference point."""
    return types.RichTextReference(text=text, name=name)


def footnote_link(text: RichTextArg, reference_name: str) -> types.RichTextReferenceLink:
    return types.RichTextReferenceLink(text=text, reference_name=reference_name)


def marked(text: RichTextArg) -> types.RichTextMarked:
    """Highlighter-style marked/highlighted text."""
    return types.RichTextMarked(text=text)


def math_inline(expression: str) -> types.RichTextMathematicalExpression:
    """Inline LaTeX-style math, e.g. math_inline(r"x^2 + y^2 = z^2")."""
    return types.RichTextMathematicalExpression(expression=expression)


def inline_button(button: "types.RichMessageButton") -> types.RichTextButton:
    """Embeds a button (see `btn()`/`url_btn()` etc. below) inline within
    running text instead of its own button row."""
    return types.RichTextButton(button=button)


# ════════════════════════════════════════════════════════════════════
#  BUTTONS
# ════════════════════════════════════════════════════════════════════
Style = enums.ButtonStyle  # Style.DEFAULT / .PRIMARY / .DANGER / .SUCCESS / .LINK


def btn(text: RichTextArg, callback_data: str | bytes, style: enums.ButtonStyle = Style.DEFAULT) -> types.RichMessageButton:
    """A standard callback button (handled by your @on_callback_query)."""
    return types.RichMessageButton(text=text, callback_data=callback_data, style=style)


def url_btn(text: RichTextArg, url: str, style: enums.ButtonStyle = Style.LINK) -> types.RichMessageButton:
    return types.RichMessageButton(text=text, url=url, style=style)


def webapp_btn(text: RichTextArg, url: str, style: enums.ButtonStyle = Style.DEFAULT) -> types.RichMessageButton:
    """Opens a Telegram Mini App / web app."""
    return types.RichMessageButton(text=text, web_app=types.WebAppInfo(url=url), style=style)


def login_btn(
    text: RichTextArg, url: str, *,
    forward_text: str | None = None, bot_username: str | None = None,
    request_write_access: bool | None = None, style: enums.ButtonStyle = Style.DEFAULT,
) -> types.RichMessageButton:
    """Telegram Login Widget button."""
    return types.RichMessageButton(
        text=text, style=style,
        login_url=types.LoginUrl(
            url=url, forward_text=forward_text, bot_username=bot_username,
            request_write_access=request_write_access,
        ),
    )


def switch_inline_btn(text: RichTextArg, query: str = "", style: enums.ButtonStyle = Style.DEFAULT) -> types.RichMessageButton:
    """Prompts the user to pick another chat and opens your bot's inline
    mode there with `query` pre-filled."""
    return types.RichMessageButton(text=text, switch_inline_query=query, style=style)


def switch_inline_here_btn(text: RichTextArg, query: str = "", style: enums.ButtonStyle = Style.DEFAULT) -> types.RichMessageButton:
    """Same as `switch_inline_btn()` but opens inline mode in the CURRENT chat."""
    return types.RichMessageButton(text=text, switch_inline_query_current_chat=query, style=style)


def switch_inline_chosen_btn(
    text: RichTextArg, *, query: str | None = None,
    allow_user_chats: bool | None = None, allow_bot_chats: bool | None = None,
    allow_group_chats: bool | None = None, allow_channel_chats: bool | None = None,
    style: enums.ButtonStyle = Style.DEFAULT,
) -> types.RichMessageButton:
    """Like `switch_inline_btn()` but restricts which chat types the user
    can pick (only relevant chat kinds are shown in the picker)."""
    return types.RichMessageButton(
        text=text, style=style,
        switch_inline_query_chosen_chat=types.SwitchInlineQueryChosenChat(
            query=query, allow_user_chats=allow_user_chats, allow_bot_chats=allow_bot_chats,
            allow_group_chats=allow_group_chats, allow_channel_chats=allow_channel_chats,
        ),
    )


def copy_btn(text: RichTextArg, copy_text: str, style: enums.ButtonStyle = Style.DEFAULT) -> types.RichMessageButton:
    """Tapping the button copies `copy_text` to the user's clipboard."""
    return types.RichMessageButton(text=text, copy_text=types.CopyTextButton(text=copy_text), style=style)


def disabled_btn(text: RichTextArg, style: enums.ButtonStyle = Style.DEFAULT) -> types.RichMessageButton:
    """A visually-present but non-interactive button (e.g. a status label)."""
    return types.RichMessageButton(text=text, disabled=types.DisabledButton(), style=style)


def buttons(*btns: "types.RichMessageButton", align: str | None = None) -> types.InputRichBlockButtons:
    """One row of up to 8 buttons. Call multiple times (one per row) inside
    `message()`/`blocks_message()` to build a multi-row keyboard."""
    assert 1 <= len(btns) <= 8, "a button row holds 1-8 buttons"
    return types.InputRichBlockButtons(buttons=list(btns), align=align)


# ════════════════════════════════════════════════════════════════════
#  MEDIA  (for photo_block/video_block/etc. below — these are the
#  *input* media wrappers, same PathType | BinaryIO | file_id you'd
#  already pass to send_photo/send_video/...)
# ════════════════════════════════════════════════════════════════════
def photo_media(media, *, caption: str = "", has_spoiler: bool | None = None, **kw) -> types.InputMediaPhoto:
    return types.InputMediaPhoto(media=media, caption=caption, has_spoiler=has_spoiler, **kw)


def video_media(media, *, caption: str = "", thumb=None, width=0, height=0, duration=0,
                 supports_streaming=True, has_spoiler: bool | None = None, **kw) -> types.InputMediaVideo:
    return types.InputMediaVideo(
        media=media, caption=caption, thumb=thumb, width=width, height=height,
        duration=duration, supports_streaming=supports_streaming, has_spoiler=has_spoiler, **kw
    )


def animation_media(media, *, caption: str = "", thumb=None, width=0, height=0, duration=0,
                     has_spoiler: bool | None = None, **kw) -> types.InputMediaAnimation:
    return types.InputMediaAnimation(
        media=media, caption=caption, thumb=thumb, width=width, height=height,
        duration=duration, has_spoiler=has_spoiler, **kw
    )


def audio_media(media, *, caption: str = "", thumb=None, duration=0, performer="", title="", **kw) -> types.InputMediaAudio:
    return types.InputMediaAudio(media=media, caption=caption, thumb=thumb, duration=duration, performer=performer, title=title, **kw)


def document_media(media, *, caption: str = "", thumb=None, **kw) -> types.InputMediaDocument:
    return types.InputMediaDocument(media=media, caption=caption, thumb=thumb, **kw)


def voice_media(media, *, caption: str = "", duration=0, **kw) -> types.InputMediaVoiceNote:
    return types.InputMediaVoiceNote(media=media, caption=caption, duration=duration, **kw)


def caption(text: RichTextArg, credit: RichTextArg | None = None) -> types.RichBlockCaption:
    """Rich (formattable) caption for photo_block/video_block/etc. —
    `credit` renders as a smaller attribution line under the caption."""
    return types.RichBlockCaption(text=text, credit=credit)


def named_media(id: str, media) -> types.InputRichMessageMedia:
    """A named media attachment for `html_message()`/`markdown_message()`
    (pass a list of these as `message(..., media=[...])`'s `media=` arg) —
    lets your HTML/Markdown content reference it inline by `id` (e.g.
    `<img src="{id}">` in HTML) instead of needing a separate block.
    `media` is one of the `*_media()` builders above (photo_media(),
    video_media(), etc.)."""
    return types.InputRichMessageMedia(id=id, media=media)


# ════════════════════════════════════════════════════════════════════
#  BLOCKS  (wraps every InputRichBlock* type — the building blocks of
#  a rich message body, used inside `message()`/`blocks_message()`)
# ════════════════════════════════════════════════════════════════════
def para(*parts: RichTextArg) -> types.InputRichBlockParagraph:
    """A paragraph block — the workhorse block, equivalent to one line/
    paragraph of a plain message. Pass one string, or several parts that
    get concatenated: para("Hello ", bold(name), "!")."""
    text = parts[0] if len(parts) == 1 else list(parts)
    return types.InputRichBlockParagraph(text=text)


def heading(text: RichTextArg, size: int = 2) -> types.InputRichBlockSectionHeading:
    """A section heading. `size` is 1 (largest) to ~4 (smallest)."""
    return types.InputRichBlockSectionHeading(text=text, size=size)


def divider() -> types.InputRichBlockDivider:
    return types.InputRichBlockDivider()


def footer(text: RichTextArg) -> types.InputRichBlockFooter:
    """Small, muted footer line — good for 'Powered by ...' style credits."""
    return types.InputRichBlockFooter(text=text)


def anchor_block(name: str) -> types.InputRichBlockAnchor:
    """An invisible jump-target block — pair with `anchor_link()` text to
    build a table-of-contents style message."""
    return types.InputRichBlockAnchor(name=name)


def photo_block(media: "types.InputMediaPhoto", cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockPhoto:
    return types.InputRichBlockPhoto(photo=media, caption=cap)


def video_block(media: "types.InputMediaVideo", cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockVideo:
    return types.InputRichBlockVideo(video=media, caption=cap)


def animation_block(media: "types.InputMediaAnimation", cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockAnimation:
    return types.InputRichBlockAnimation(animation=media, caption=cap)


def audio_block(media: "types.InputMediaAudio", cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockAudio:
    return types.InputRichBlockAudio(audio=media, caption=cap)


def document_block(media: "types.InputMediaDocument", cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockDocument:
    return types.InputRichBlockDocument(document=media, caption=cap)


def voice_block(media: "types.InputMediaVoiceNote", cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockVoiceNote:
    return types.InputRichBlockVoiceNote(voice_note=media, caption=cap)


def collage(*blocks, cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockCollage:
    """A grid of media blocks (photo_block/video_block/...) sharing one caption."""
    return types.InputRichBlockCollage(blocks=list(blocks), caption=cap)


def slideshow(*blocks, cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockSlideshow:
    """Like `collage()` but swipeable one-at-a-time instead of a grid."""
    return types.InputRichBlockSlideshow(blocks=list(blocks), caption=cap)


def list_item(*blocks, has_checkbox: bool | None = None, is_checked: bool | None = None,
              value: int | None = None, type: str | None = None) -> types.InputRichBlockListItem:
    """One item of `bullet_list()`. Pass `has_checkbox=True` for a checklist
    item, `type="ordered"` for numbered lists (default is bulleted)."""
    return types.InputRichBlockListItem(blocks=list(blocks), has_checkbox=has_checkbox, is_checked=is_checked, value=value, type=type)


def bullet_list(*items: "types.InputRichBlockListItem") -> types.InputRichBlockList:
    """Build items with `list_item()` first: bullet_list(list_item(para("A")), list_item(para("B")))."""
    return types.InputRichBlockList(items=list(items))


def table_cell(text: RichTextArg | None = None, *, is_header: bool | None = None,
               colspan: int | None = None, rowspan: int | None = None,
               align: str | None = None, valign: str | None = None) -> types.RichBlockTableCell:
    return types.RichBlockTableCell(text=text, is_header=is_header, colspan=colspan, rowspan=rowspan, align=align, valign=valign)


def table(rows: list[list["types.RichBlockTableCell"]], *, bordered: bool | None = None,
          striped: bool | None = None, compact: bool | None = None,
          cap: RichTextArg | None = None) -> types.InputRichBlockTable:
    """`rows` is a list of rows, each a list of `table_cell(...)`."""
    return types.InputRichBlockTable(cells=rows, is_bordered=bordered, is_striped=striped, is_compact=compact, caption=cap)


def details(summary: RichTextArg, *blocks, is_open: bool | None = None) -> types.InputRichBlockDetails:
    """A collapsible <details>-style section: a `summary` line the user
    taps to reveal the nested `blocks`."""
    return types.InputRichBlockDetails(summary=summary, blocks=list(blocks), is_open=is_open)


def blockquote(*blocks, credit: RichTextArg | None = None) -> types.InputRichBlockBlockQuotation:
    """A block-level quotation wrapping one or more nested blocks."""
    return types.InputRichBlockBlockQuotation(blocks=list(blocks), credit=credit)


def expandable_quote(text: RichTextArg, credit: RichTextArg | None = None) -> types.InputRichBlockExpandableBlockQuotation:
    """A quote block that starts collapsed with a 'Show more' toggle."""
    return types.InputRichBlockExpandableBlockQuotation(text=text, credit=credit)


def pull_quote(text: RichTextArg, credit: RichTextArg | None = None) -> types.InputRichBlockPullQuotation:
    """A visually-emphasized standalone quote (magazine-style pull-quote)."""
    return types.InputRichBlockPullQuotation(text=text, credit=credit)


def preformatted(text: RichTextArg, language: str | None = None) -> types.InputRichBlockPreformatted:
    """A full code block. `language` enables syntax highlighting (e.g. "python")."""
    return types.InputRichBlockPreformatted(text=text, language=language)


def map_block(latitude: float, longitude: float, *, zoom: int | None = None,
              width: int | None = None, height: int | None = None,
              cap: "types.RichBlockCaption | None" = None) -> types.InputRichBlockMap:
    return types.InputRichBlockMap(
        location=types.Location(latitude=latitude, longitude=longitude),
        zoom=zoom, width=width, height=height, caption=cap,
    )


def math_block(expression: str) -> types.InputRichBlockMathematicalExpression:
    """A standalone (block-level, centered) LaTeX-style expression."""
    return types.InputRichBlockMathematicalExpression(expression=expression)


def thinking(text: RichTextArg) -> types.InputRichBlockThinking:
    """Renders as a collapsed 'thought process' style block (chain-of-thought UI)."""
    return types.InputRichBlockThinking(text=text)


# ════════════════════════════════════════════════════════════════════
#  MESSAGE  (wraps InputRichMessage construction)
# ════════════════════════════════════════════════════════════════════
def message(*blocks, media: list | None = None, rtl: bool | None = None,
            skip_entity_detection: bool | None = None) -> types.InputRichMessage:
    """The main way to build a rich message: message(para(...), divider(), buttons(...), ...)."""
    return types.InputRichMessage(blocks=list(blocks), media=media, is_rtl=rtl, skip_entity_detection=skip_entity_detection)


# alias — `blocks_message` reads more explicitly next to `html_message`/`markdown_message`
blocks_message = message


def html_message(html: str, *, rtl: bool | None = None, skip_entity_detection: bool | None = None) -> types.InputRichMessage:
    """Build straight from an HTML string instead of block-by-block."""
    return types.InputRichMessage(html=html, is_rtl=rtl, skip_entity_detection=skip_entity_detection)


def markdown_message(md: str, *, rtl: bool | None = None, skip_entity_detection: bool | None = None) -> types.InputRichMessage:
    """Build straight from a Markdown string instead of block-by-block."""
    return types.InputRichMessage(markdown=md, is_rtl=rtl, skip_entity_detection=skip_entity_detection)


def text(content: RichTextArg) -> types.InputRichMessage:
    """The rich-message equivalent of a plain `send_message(text)` call —
    a single paragraph, no buttons. The most common case — use this unless
    you actually need multiple blocks/buttons."""
    return types.InputRichMessage(blocks=[types.InputRichBlockParagraph(text=content)])


# common alias some codebases expect
text_message = text


# ════════════════════════════════════════════════════════════════════
#  PLAIN-TEXT FALLBACK RENDERING
#  Best-effort flatten of a RichText tree / block list down to a plain
#  string, for the automatic bot->user degrade in send()/edit()/reply()
#  below, or for logging/previews. Formatting-only nodes (bold/italic/
#  etc.) degrade to Pyrogram markdown syntax so *some* formatting still
#  shows even in the plain fallback; structural nodes (media/table/map/
#  math/...) degrade to a short bracketed label since there's no text
#  equivalent for them.
# ════════════════════════════════════════════════════════════════════
def _flatten_richtext(node: Any) -> str:
    if node is None:
        return ""
    if isinstance(node, str):
        return node
    if isinstance(node, (list, tuple)):
        return "".join(_flatten_richtext(n) for n in node)

    inner = _flatten_richtext(getattr(node, "text", None))
    if isinstance(node, types.RichTextBold):
        return f"**{inner}**"
    if isinstance(node, types.RichTextItalic):
        return f"__{inner}__"
    if isinstance(node, types.RichTextUnderline):
        return f"--{inner}--"
    if isinstance(node, types.RichTextStrikethrough):
        return f"~~{inner}~~"
    if isinstance(node, types.RichTextSpoiler):
        return f"||{inner}||"
    if isinstance(node, types.RichTextCode):
        return f"`{inner}`"
    if isinstance(node, types.RichTextUrl):
        return f"[{inner}]({node.url})"
    if isinstance(node, types.RichTextTextMention):
        return f"[{inner}](tg://user?id={node.user.id})"
    if isinstance(node, types.RichTextMention):
        return f"{inner} (@{node.username})" if inner and inner != node.username else f"@{node.username}"
    if isinstance(node, types.RichTextCustomEmoji):
        return node.alternative_text or ""
    if isinstance(node, (types.RichTextHashtag, types.RichTextBotCommand, types.RichTextPhoneNumber,
                          types.RichTextEmailAddress, types.RichTextCashtag, types.RichTextBankCardNumber,
                          types.RichTextSubscript, types.RichTextSuperscript, types.RichTextMarked,
                          types.RichTextAnchor, types.RichTextAnchorLink, types.RichTextReference,
                          types.RichTextReferenceLink, types.RichTextDateTime)):
        return inner
    if isinstance(node, types.RichTextMathematicalExpression):
        return node.expression
    if isinstance(node, types.RichTextButton):
        return f"[{_flatten_richtext(getattr(node.button, 'text', ''))}]"
    return inner or str(node)


def _flatten_block(block: Any) -> str:
    if isinstance(block, types.InputRichBlockParagraph):
        return _flatten_richtext(block.text)
    if isinstance(block, types.InputRichBlockFooter):
        return _flatten_richtext(block.text)
    if isinstance(block, types.InputRichBlockSectionHeading):
        return _flatten_richtext(block.text).upper()
    if isinstance(block, types.InputRichBlockDivider):
        return "───────────"
    if isinstance(block, types.InputRichBlockPreformatted):
        return f"```{block.language or ''}\n{_flatten_richtext(block.text)}\n```"
    if isinstance(block, (types.InputRichBlockPullQuotation, types.InputRichBlockExpandableBlockQuotation)):
        return f"> {_flatten_richtext(block.text)}"
    if isinstance(block, types.InputRichBlockBlockQuotation):
        return "\n".join(f"> {line}" for line in "\n".join(_flatten_block(b) for b in block.blocks).splitlines())
    if isinstance(block, types.InputRichBlockDetails):
        inner = "\n".join(_flatten_block(b) for b in block.blocks)
        return f"{_flatten_richtext(block.summary)}\n{inner}"
    if isinstance(block, types.InputRichBlockList):
        lines = []
        for item in block.items:
            mark = "☑" if item.is_checked else ("☐" if item.has_checkbox else "•")
            lines.append(f"{mark} " + " ".join(_flatten_block(b) for b in item.blocks))
        return "\n".join(lines)
    if isinstance(block, types.InputRichBlockButtons):
        return " | ".join(f"[{_flatten_richtext(b.text)}]" for b in block.buttons)
    if isinstance(block, types.InputRichBlockAnchor):
        return ""
    if isinstance(block, types.InputRichBlockMathematicalExpression):
        return block.expression
    if isinstance(block, (types.InputRichBlockPhoto, types.InputRichBlockVideo, types.InputRichBlockAnimation,
                           types.InputRichBlockAudio, types.InputRichBlockDocument, types.InputRichBlockVoiceNote,
                           types.InputRichBlockCollage, types.InputRichBlockSlideshow, types.InputRichBlockMap)):
        label = type(block).__name__.replace("InputRichBlock", "")
        cap = getattr(block, "caption", None)
        cap_text = f": {_flatten_richtext(cap.text)}" if cap else ""
        return f"[{label}{cap_text}]"
    if isinstance(block, types.InputRichBlockThinking):
        return f"[Thinking] {_flatten_richtext(block.text)}"
    if isinstance(block, types.InputRichBlockTable):
        rows = [" | ".join(_flatten_richtext(c.text) for c in row) for row in block.cells]
        return "\n".join(rows)
    return ""


def flatten_message(rich_message: "types.InputRichMessage") -> str:
    """Best-effort plain-text rendering of an InputRichMessage — used
    automatically by send()/edit()/reply() below when the sending client
    is a user account (Rich Messages don't render for those). Pass your
    own `fallback_text=` to those calls instead whenever you want a
    hand-written plain version rather than this generic flatten."""
    if rich_message.markdown:
        return rich_message.markdown
    if rich_message.html:
        return rich_message.html  # best-effort — no HTML stripping, shown as-is
    lines = [_flatten_block(b) for b in (rich_message.blocks or [])]
    return "\n".join(line for line in lines if line)


# ════════════════════════════════════════════════════════════════════
#  SEND / EDIT / REPLY  — the easy, safe call surface.
#  Handles the two footguns from the module docstring automatically:
#  bot-only rich messages, and numeric-string chat_id misdetection.
# ════════════════════════════════════════════════════════════════════
def _safe_chat_id(chat_id):
    """int-ify a numeric chat_id string (e.g. str(chat.id) from elsewhere
    in a codebase) so kurigram's resolve_peer() can't mistake it for a
    phone number. Usernames / "@handle" strings pass through untouched."""
    if isinstance(chat_id, str):
        s = chat_id.strip()
        digits = s[1:] if s.startswith("-") else s
        if digits.isdigit():
            return int(s)
    return chat_id


async def is_bot_client(client) -> bool:
    """True if `client` is logged in as a bot account. Rich Messages only
    render for bots — see the module docstring. Uses the cached
    `client.me` (set once at Client.start()); fetches it if not cached yet."""
    try:
        if client.me is None:
            await client.get_me()
        return bool(client.me and client.me.is_bot)
    except Exception:
        return False


async def send(
    client, chat_id, msg: "types.InputRichMessage", *,
    fallback_text: str | None = None, is_bot: bool | None = None,
    reply_markup=None, disable_notification: bool | None = None,
    reply_parameters=None, effect_id: int | None = None,
):
    """Send a rich message. Auto-degrades to plain text if `client` isn't
    a bot account, and auto-fixes a numeric-string `chat_id`. Pass
    `is_bot=True/False` yourself to skip the `client.me` check (e.g. if
    you already know it, for a hot loop); pass `fallback_text=` for a
    hand-written plain version instead of the generic flatten."""
    cid = _safe_chat_id(chat_id)
    bot = is_bot if is_bot is not None else await is_bot_client(client)
    if bot:
        return await client.send_rich_message(
            cid, rich_message=msg, reply_markup=reply_markup,
            disable_notification=disable_notification,
            reply_parameters=reply_parameters, effect_id=effect_id,
        )
    return await client.send_message(
        cid, fallback_text if fallback_text is not None else flatten_message(msg),
        reply_markup=reply_markup, disable_notification=disable_notification,
        reply_parameters=reply_parameters,
    )


async def edit(
    client, chat_id, message_id: int, msg: "types.InputRichMessage", *,
    fallback_text: str | None = None, is_bot: bool | None = None, reply_markup=None,
):
    """Edit a message in place with new rich content. Same auto-degrade /
    auto-int-ify guarantees as send()."""
    cid = _safe_chat_id(chat_id)
    bot = is_bot if is_bot is not None else await is_bot_client(client)
    if bot:
        return await client.edit_message_text(cid, message_id, rich_message=msg, reply_markup=reply_markup)
    return await client.edit_message_text(
        cid, message_id, fallback_text if fallback_text is not None else flatten_message(msg),
        reply_markup=reply_markup,
    )


async def reply(
    message_obj: "types.Message", msg: "types.InputRichMessage", *,
    fallback_text: str | None = None, is_bot: bool | None = None, reply_markup=None,
    disable_notification: bool | None = None,
):
    """Reply to an incoming Message, using its own client automatically
    (message_obj._client — the same internal attribute Message.reply_text/
    reply_rich use). Same auto-degrade guarantee as send()."""
    client = message_obj._client
    bot = is_bot if is_bot is not None else await is_bot_client(client)
    if bot:
        return await message_obj.reply_rich(
            rich_message=msg, reply_markup=reply_markup, disable_notification=disable_notification,
        )
    return await message_obj.reply_text(
        fallback_text if fallback_text is not None else flatten_message(msg),
        reply_markup=reply_markup, disable_notification=disable_notification,
    )


async def quick(client, chat_id, plain_text: str, **kw):
    """The single-line shortcut for the common case: one line of text, no
    blocks/buttons to compose by hand. Equivalent to
    send(client, chat_id, text(plain_text)), skipping message()/text() entirely."""
    return await send(client, chat_id, text(plain_text), fallback_text=plain_text, **kw)


async def quick_edit(client, chat_id, message_id: int, plain_text: str, **kw):
    return await edit(client, chat_id, message_id, text(plain_text), fallback_text=plain_text, **kw)
