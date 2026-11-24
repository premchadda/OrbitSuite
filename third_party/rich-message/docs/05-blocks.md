# Blocks

A rich message is a list of **blocks**, passed to `rp.message(*blocks)`
(see [06-message-builders.md](06-message-builders.md)). This page catalogues
every block type richpyro supports.

## Text blocks

```python
rp.para("Plain text, or ", rp.bold("formatted"), " parts")   # the workhorse — one paragraph
rp.heading("Section title", size=2)                           # size 1 (largest) .. ~4 (smallest)
rp.footer(rp.italic("Powered by richpyro"))                   # small, muted line
rp.divider()                                                   # a horizontal rule, no arguments
rp.preformatted("print('hi')", language="python")              # a full code block
rp.pull_quote("A short standout quote", credit="- Someone")
rp.expandable_quote("Long text that starts collapsed...", credit="- Someone")
rp.thinking("Reasoning shown as a collapsed thought block")
rp.math_block(r"\int_0^1 x^2 dx = \frac{1}{3}")                # standalone centered math
```

## Media blocks

Each media block wraps an `InputMedia*` object built with the matching
`*_media()` helper — same `media` argument you already pass to
`send_photo`/`send_video`/etc. (a file path, a `BinaryIO`, or a `file_id`
string):

```python
rp.photo_block(rp.photo_media("photo.jpg", caption="", has_spoiler=False))
rp.video_block(rp.video_media("video.mp4", duration=30, width=1280, height=720))
rp.animation_block(rp.animation_media("clip.gif"))
rp.audio_block(rp.audio_media("song.mp3", performer="Artist", title="Song"))
rp.document_block(rp.document_media("report.pdf"))
rp.voice_block(rp.voice_media("note.ogg", duration=5))
```

Add a rich (formattable) caption with `rp.caption(...)`:

```python
rp.photo_block(
    rp.photo_media("photo.jpg"),
    rp.caption(rp.bold("Before"), credit="Photo: Ramu"),
)
```

### Multiple media in one block

```python
rp.collage(                                       # grid layout
    rp.photo_block(rp.photo_media("a.jpg")),
    rp.photo_block(rp.photo_media("b.jpg")),
    cap=rp.caption("Two photos"),
)
rp.slideshow(...)                                  # same idea, swipeable instead of a grid
```

### A location

```python
rp.map_block(latitude=28.6139, longitude=77.2090, zoom=14, width=400, height=300)
```

## Lists

```python
rp.bullet_list(
    rp.list_item(rp.para("First item")),
    rp.list_item(rp.para("Second item")),
)

# a checklist:
rp.bullet_list(
    rp.list_item(rp.para("Done task"), has_checkbox=True, is_checked=True),
    rp.list_item(rp.para("Pending task"), has_checkbox=True, is_checked=False),
)

# numbered:
rp.bullet_list(
    rp.list_item(rp.para("Step one"), type="ordered"),
    rp.list_item(rp.para("Step two"), type="ordered"),
)
```

Each `list_item(*blocks, ...)` can hold more than one block, not just a
single paragraph.

## Tables

```python
rp.table(
    rows=[
        [rp.table_cell("Plan", is_header=True), rp.table_cell("Price", is_header=True)],
        [rp.table_cell("Day"), rp.table_cell("₹20")],
        [rp.table_cell("Week"), rp.table_cell("₹100")],
    ],
    bordered=True,
    striped=True,
)
```

## Collapsible section

```python
rp.details(
    "Tap to see full terms",              # summary — always visible
    rp.para("The full terms text goes here..."),
    is_open=False,
)
```

## Block-level quote wrapping other blocks

```python
rp.blockquote(
    rp.para("This whole block is quoted,"),
    rp.para("including multiple paragraphs."),
    credit="- Someone",
)
```
(For a single-paragraph quote, `rp.pull_quote(...)` or
`rp.expandable_quote(...)` above are simpler.)

## Jump targets

```python
rp.anchor_block("section2")   # invisible marker; combine with rp.anchor_link() text elsewhere (see 03-text-formatting.md)
```

## Buttons

Covered in full in [04-buttons-and-callbacks.md](04-buttons-and-callbacks.md):

```python
rp.buttons(rp.btn("Yes", "confirm_yes"), rp.url_btn("Docs", "https://example.com"))
```

## Everything at once

```python
card = rp.message(
    rp.heading("Order #1234"),
    rp.divider(),
    rp.para("Status: ", rp.bold("Shipped")),
    rp.photo_block(rp.photo_media("package.jpg")),
    rp.table(rows=[[rp.table_cell("Item"), rp.table_cell("Qty")],
                   [rp.table_cell("Widget"), rp.table_cell("2")]]),
    rp.footer(rp.italic("Thanks for your order!")),
    rp.buttons(rp.btn("Track package", "track_1234")),
)
```
