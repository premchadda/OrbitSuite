"""Owner-requested Telegram audio -> local whisper.cpp -> private Telegram text.

The Bot API file ID comes from a reply in the authenticated owner chat; this
module never handles accounts, audio URLs, arbitrary commands or cloud AI.
"""
from __future__ import annotations

from pathlib import Path
import re
import subprocess
import sys
import tempfile

from telegram_parts import safe_telegram_path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
from services.ai.transcribe import transcribe_local_media  # noqa: E402

FILE_ID = re.compile(r"^[A-Za-z0-9_-]{16,512}$")
MODEL_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,100}\.bin$")
EXTENSIONS = {".oga", ".ogg", ".mp3", ".m4a", ".wav", ".flac", ".mp4", ".aac"}
PUBLIC_DOWNLOAD_LIMIT = 20 * 1024 * 1024
LOCAL_DOWNLOAD_LIMIT = 200 * 1024 * 1024


def transcribe_telegram_audio(job: dict, client, token: str, api_base: str,
                              *, model_root: str, model_name: str,
                              transcriber=transcribe_local_media) -> dict:
    file_id = str(job.get("file_id") or "")
    if job.get("task") != "transcribe" or not FILE_ID.fullmatch(file_id):
        raise ValueError("Expected authorized transcription file ID")
    if not model_root or not MODEL_NAME.fullmatch(str(model_name)):
        raise ValueError("Install a private model and configure ORBIT_WHISPER_MODEL_ROOT/MODEL")
    local_api = api_base.startswith("http://")
    limit = LOCAL_DOWNLOAD_LIMIT if local_api else PUBLIC_DOWNLOAD_LIMIT
    response = client.post(api_base + "/bot" + token + "/getFile",
                           json={"file_id": file_id}, timeout=30)
    metadata = response.json()
    if not metadata.get("ok"):
        raise RuntimeError("Bot API cannot access the replied-to audio")
    remote = metadata.get("result") or {}
    relative = safe_telegram_path(remote.get("file_path"))
    if Path(relative).suffix.lower() not in EXTENSIONS:
        raise ValueError("Unsupported Telegram audio extension")
    advertised = int(remote.get("file_size") or 0)
    if advertised > limit:
        raise ValueError("Audio exceeds Bot API download limit")
    with tempfile.TemporaryDirectory(prefix="orbit-transcribe-") as folder:
        base = Path(folder)
        original = base / ("input" + Path(relative).suffix.lower())
        size = 0
        with client.stream("GET", api_base + "/file/bot" + token + "/" + relative,
                           timeout=180) as stream, original.open("xb") as output:
            stream.raise_for_status()
            for chunk in stream.iter_bytes(chunk_size=1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ValueError("Audio download exceeded file size limit")
                output.write(chunk)
        if not size or (advertised and size != advertised):
            raise ValueError("Incomplete Telegram audio download")
        wav = base / "speech.wav"
        try:
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                            "-i", str(original), "-ac", "1", "-ar", "16000",
                            "-c:a", "pcm_s16le", str(wav)],
                           check=True, capture_output=True, timeout=180)
        except (subprocess.SubprocessError, OSError) as error:
            raise RuntimeError("Local audio conversion failed") from error
        if not wav.is_file() or wav.stat().st_size > LOCAL_DOWNLOAD_LIMIT:
            raise ValueError("Converted audio missing or too large")
        transcript = transcriber(wav, media_root=base,
                                 model_path=Path(model_root) / model_name,
                                 model_root=model_root)
    body = (transcript or 'No clear speech detected.').strip()[:3800]
    sent = client.post(api_base + "/bot" + token + "/sendMessage",
                       json={"chat_id": str(job["dest"]), "text": "Transcript:\n" + body,
                             "disable_notification": True}, timeout=30)
    result = sent.json()
    if not result.get("ok"):
        raise RuntimeError("Bot API rejected transcription message")
    return {"uploaded": 1, "files": [{"message_id": result.get("result", {}).get("message_id"),
                                        "type": "transcript", "characters": len(body)}]}
