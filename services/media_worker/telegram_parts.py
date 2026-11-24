"""Owner-requested join of accessible Telegram file-ID parts, entirely ephemeral.

No scraping, user sessions, arbitrary file URLs, shell commands or retained
download directories. Bot API size limits are checked before transferring.
"""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
from pathlib import Path, PurePosixPath
import re
import tempfile

from media_features import (LOCAL_BOT_API_UPLOAD_MAX, ProgressReader,
                            STANDARD_UPLOAD_MAX, join_parts)


PART = re.compile(r"^([A-Za-z0-9][A-Za-z0-9._ -]{0,116})\.part(\d{3})$")
FILE_ID = re.compile(r"^[A-Za-z0-9_-]{16,512}$")
PATH = re.compile(r"^[A-Za-z0-9_./-]{1,250}$")
MAX_PARTS = 10
PUBLIC_DOWNLOAD_MAX = 20 * 1024 * 1024


def check_parts(raw, *, local_api: bool):
    if not isinstance(raw, list) or not 2 <= len(raw) <= MAX_PARTS:
        raise ValueError("Join requires 2–10 owner-submitted parts")
    parsed = []
    for index, item in enumerate(raw, start=1):
        if not isinstance(item, dict) or set(item) != {"file_id", "filename", "file_size"}:
            raise ValueError("Invalid part item")
        filename = item["filename"]
        match = PART.fullmatch(filename) if isinstance(filename, str) else None
        if not match or int(match[2]) != index or not FILE_ID.fullmatch(str(item["file_id"])):
            raise ValueError("Parts must be in exact sequential filename order")
        size = item["file_size"]
        limit = LOCAL_BOT_API_UPLOAD_MAX if local_api else PUBLIC_DOWNLOAD_MAX
        if type(size) is not int or not 1 <= size <= limit:
            raise ValueError("Part exceeds the selected Bot API file-download limit")
        parsed.append((match[1], filename, item["file_id"], size))
    if len({p[0] for p in parsed}) != 1:
        raise ValueError("Parts do not share an original filename")
    maximum = LOCAL_BOT_API_UPLOAD_MAX if local_api else STANDARD_UPLOAD_MAX
    if sum(p[3] for p in parsed) > maximum:
        raise ValueError("Joined file exceeds the Bot API upload limit")
    return parsed


def safe_telegram_path(raw: object) -> str:
    value = str(raw or "")
    path = PurePosixPath(value)
    if (not PATH.fullmatch(value) or path.is_absolute() or ".." in path.parts
            or str(path) != value or len(path.parts) < 2):
        raise ValueError("Telegram returned an invalid file path")
    return value


def join_telegram_parts(job: dict, client, token: str, api_base: str, progress=None) -> dict:
    local_api = api_base.startswith("http://")
    parsed = check_parts(job.get("parts"), local_api=local_api)
    maximum = LOCAL_BOT_API_UPLOAD_MAX if local_api else STANDARD_UPLOAD_MAX
    if not isinstance(job.get("dest"), (str, int)):
        raise ValueError("Missing Telegram destination")
    with tempfile.TemporaryDirectory(prefix="orbit-join-") as folder:
        root = Path(folder)
        fragments = root / "fragments"
        fragments.mkdir()
        target = root / parsed[0][0]
        parts = []
        for _, filename, file_id, expected_size in parsed:
            response = client.post(api_base + "/bot" + token + "/getFile",
                                   json={"file_id": file_id}, timeout=30)
            data = response.json()
            if not data.get("ok"):
                raise RuntimeError("Bot API cannot access one requested part")
            record = data.get("result") or {}
            if int(record.get("file_size") or 0) > expected_size:
                raise ValueError("Telegram part larger than the original size")
            relative = safe_telegram_path(record.get("file_path"))
            destination = fragments / filename
            size = 0
            url = api_base + "/file/bot" + token + "/" + relative
            with client.stream("GET", url, timeout=180) as stream, destination.open("xb") as output:
                stream.raise_for_status()
                for chunk in stream.iter_bytes(chunk_size=1024 * 1024):
                    size += len(chunk)
                    if size > expected_size:
                        raise ValueError("Telegram returned too many file bytes")
                    output.write(chunk)
            if size != expected_size:
                raise ValueError("Incomplete part download")
            parts.append(destination)
            if progress:
                progress({"stage": "download_started", "done": len(parts), "total": len(parsed)})
        joined = join_parts(parts, target, max_bytes=maximum)
        digest = hashlib.sha256()
        with joined.open("rb") as stream:
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
        data = {"chat_id": str(job["dest"]), "disable_notification": "true"}
        if int(job.get("dest_topic") or 0):
            data["message_thread_id"] = str(job["dest_topic"])
        with ExitStack() as stack:
            stream = stack.enter_context(joined.open("rb"))
            response = client.post(api_base + "/bot" + token + "/sendDocument",
                                   data=data,
                                   files={"document": (joined.name,
                                       ProgressReader(stream, joined.stat().st_size, progress),
                                       "application/octet-stream")}, timeout=300)
        result = response.json()
        if not result.get("ok"):
            raise RuntimeError("Telegram rejected joined file upload")
        return {"uploaded": 1, "files": [{"message_id": result.get("result", {}).get("message_id"),
            "name": joined.name, "size": joined.stat().st_size, "sha256": digest.hexdigest()}]}
