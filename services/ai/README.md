# Optional offline AI adapters

`personal_extensions.js` provides deterministic, free, offline filename
sanitization (`/smartname`), short extractive summaries (`/summarize`), keyword
metadata tags (`/tag`), and `/searchnl` over indexed media metadata. These are
heuristics when no model is configured. `apps/worker/src/ai_inference.js` adds
**optional real text inference** through an explicitly configured trusted
Ollama-compatible endpoint. Set `ORBIT_AI_BASE_URL` to an installed local
`http://127.0.0.1:11434` service (or trusted HTTPS endpoint), set
`ORBIT_AI_MODEL`, and use `/feature personal_ai on` in the private owner chat.
Only explicit owner text in `/smartname`, `/summarize`, `/tag` and
`/tagarchive ID auto` is submitted; no background archive or group processing.
Input and output lengths are bounded. No model is installed automatically.
Never send sensitive metadata to an untrusted remote AI provider.

Archive tags are stored as small searchable labels via `/tagarchive`, `/tags`,
`/tagsearch`, `/tagremove`; only Telegram archive metadata stays in the DB.

`transcribe.py` offers an explicit local `whisper.cpp` adapter. Install
`whisper-cli` and a model `.bin` ahead of time, then call
`transcribe_local_media(media_path, media_root=..., model_path=...,
model_root=...)`. It validates both input locations and limits media size,
runtime, and transcript length. It does **not** download or upload media or
model data. The optional `services/media_worker/telegram_transcribe.py`
now connects an explicit owner reply `/transcribe` to this local adapter
through the media queue; it remains OFF until both required feature flags
are enabled. No model or binary is bundled or downloaded automatically.

`lookup.py` performs opt-in Wikipedia and RDAP requests through the pinned-DNS
HTTPS parser, or installed offline Argos translation packages. Wikipedia search
is limited to Wikipedia articles. Translation requires local packs and supports
`source:target text` syntax, e.g. `en:hi Hello`.

Run offline adapter tests from the repository root:

```bash
python3 -m unittest discover -s services/ai -p 'test_*.py'
```
