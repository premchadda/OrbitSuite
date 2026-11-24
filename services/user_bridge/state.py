"""Crash-safe, metadata-only state for optional authorized history backfills.

Saving a copy may succeed even if its response is lost. A checkpoint therefore
records an in-flight ID *before* sending, and refuses an implicit retry after
interruption. Its JSON contains no Telegram credentials or message payload.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile

MAX_STATE_BYTES = 2 * 1024 * 1024
SCHEMA_VERSION = 1


def file_identity(message: object) -> str | None:
    """Hash a Telegram file_unique_id, not file bytes or reusable credentials."""
    media = ("document", "video", "audio", "voice", "animation", "sticker", "video_note")
    target = next((getattr(message, name, None) for name in media if getattr(message, name, None)), None)
    if target is None:
        photos = getattr(message, "photo", None)
        target = photos[-1] if isinstance(photos, (list, tuple)) and photos else photos
    unique = getattr(target, "file_unique_id", None)
    if not isinstance(unique, str) or not unique:
        return None
    return hashlib.sha256(unique.encode("utf-8")).hexdigest()


def metadata_record(message: object, source: str, message_id: int,
                    *, include_filename: bool = False) -> dict:
    fields = ("document", "video", "photo", "audio", "voice", "animation", "sticker", "video_note")
    media_kind = next((name for name in fields if getattr(message, name, None) is not None), "text")
    result = {"source": source, "message_id": message_id, "media_kind": media_kind,
              "topic": getattr(message, "message_thread_id", None)}
    date = getattr(message, "date", None)
    if isinstance(date, datetime):
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        result["date"] = date.astimezone(timezone.utc).isoformat(timespec="seconds")
    if include_filename:
        attachment = getattr(message, media_kind, None)
        if media_kind == "photo" and isinstance(attachment, (list, tuple)) and attachment:
            attachment = attachment[-1]
        filename = getattr(attachment, "file_name", None)
        if isinstance(filename, str):
            result["filename"] = filename[:180]
    return result


@dataclass
class State:
    identity: dict
    next_id: int
    inflight: int | None = None
    seen_files: list[str] = field(default_factory=list)
    counters: dict[str, int] = field(default_factory=lambda: {
        "copied": 0, "skipped": 0, "previewed": 0, "uncertain_skipped": 0,
    })

    def to_json(self) -> dict:
        return {"version": SCHEMA_VERSION, "identity": self.identity, "next_id": self.next_id,
                "inflight": self.inflight, "seen_files": self.seen_files,
                "counters": self.counters}


class Checkpoint:
    def __init__(self, path: Path, identity: dict):
        self.path = path
        self.identity = identity
        self.state: State | None = None

    @contextmanager
    def exclusive(self):
        """Hold an exclusive process lock for the entire backfill run."""
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock_path = self.path.with_name(self.path.name + ".lock")
        if lock_path.is_symlink():
            raise ValueError("Refusing symlink checkpoint lock")
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError as exc:
            raise ValueError("Checkpoint in use; another run may still be active") from exc
        try:
            os.close(fd)
            yield self
        finally:
            lock_path.unlink(missing_ok=True)

    def start(self, first_id: int, *, resume: bool = False,
              skip_uncertain: bool = False, retry_uncertain: bool = False) -> State:
        if skip_uncertain and retry_uncertain:
            raise ValueError("Choose either skip or confirmed retry for an uncertain send")
        if resume:
            state = self.load()
            if state.identity != self.identity:
                raise ValueError("Checkpoint source/destination/topic/mode/range differs")
            if state.inflight is not None:
                if skip_uncertain:
                    state.next_id = state.inflight + 1
                    state.inflight = None
                    state.counters["uncertain_skipped"] += 1
                    self.state = state
                    self.save()
                elif retry_uncertain:
                    state.next_id = state.inflight
                    state.inflight = None
                    self.state = state
                    self.save()
                else:
                    raise ValueError("Uncertain in-flight message requires explicit reconciliation")
        else:
            if self.path.exists():
                raise ValueError("Checkpoint already exists; use --resume or choose a new file")
            state = State(self.identity, first_id)
            self.state = state
            self.save()
        self.state = state
        return state

    def load(self) -> State:
        if self.path.is_symlink():
            raise ValueError("Refusing symlink checkpoint")
        try:
            if self.path.stat().st_size > MAX_STATE_BYTES:
                raise ValueError("Checkpoint exceeds size limit")
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ValueError("Checkpoint missing or invalid") from exc
        if not isinstance(raw, dict) or raw.get("version") != SCHEMA_VERSION:
            raise ValueError("Unsupported checkpoint format")
        if not isinstance(raw.get("identity"), dict) or not isinstance(raw.get("next_id"), int):
            raise ValueError("Invalid checkpoint fields")
        if raw.get("inflight") is not None and not isinstance(raw.get("inflight"), int):
            raise ValueError("Invalid in-flight marker")
        hashes = raw.get("seen_files", [])
        if not isinstance(hashes, list) or len(hashes) > 10000 or any(
            not isinstance(item, str) or len(item) != 64 for item in hashes
        ):
            raise ValueError("Invalid deduplication data")
        counters = raw.get("counters", {})
        if not isinstance(counters, dict) or any(
            not isinstance(value, int) or value < 0 for value in counters.values()
        ):
            raise ValueError("Invalid counters")
        return State(raw["identity"], raw["next_id"], raw.get("inflight"), hashes, counters)

    def save(self) -> None:
        if self.state is None:
            raise ValueError("No checkpoint state")
        if self.path.is_symlink():
            raise ValueError("Refusing symlink checkpoint")
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        payload = json.dumps(self.state.to_json(), sort_keys=True, separators=(",", ":"))
        if len(payload.encode("utf-8")) > MAX_STATE_BYTES:
            raise ValueError("Checkpoint exceeds size limit")
        fd, temp_path = tempfile.mkstemp(prefix=".orbit-checkpoint-", dir=self.path.parent)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.path)
        finally:
            if os.path.exists(temp_path):
                os.unlink(temp_path)

    def mark_inflight(self, message_id: int) -> None:
        assert self.state is not None
        if message_id != self.state.next_id or self.state.inflight is not None:
            raise ValueError("Unexpected checkpoint send order")
        self.state.inflight = message_id
        self.save()

    def record(self, message_id: int, status: str, *, file_hash: str | None = None) -> None:
        assert self.state is not None
        if message_id != self.state.next_id:
            raise ValueError("Unexpected checkpoint progress")
        if status not in {"copied", "skipped", "previewed"}:
            raise ValueError("Unknown checkpoint status")
        self.state.inflight = None
        self.state.next_id = message_id + 1
        self.state.counters[status] += 1
        if file_hash and status in {"copied", "previewed"} and file_hash not in self.state.seen_files:
            self.state.seen_files.append(file_hash)
        self.save()


class Report:
    """Strictly local JSONL report; never saves captions/OTP/session strings."""
    def __init__(self, path: Path, *, resume: bool = False):
        if path.is_symlink():
            raise ValueError("Refusing symlink report")
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        flags = os.O_WRONLY | os.O_CREAT | (os.O_APPEND if resume else os.O_EXCL)
        fd = os.open(path, flags, 0o600)
        self.stream = os.fdopen(fd, "a" if resume else "w", encoding="utf-8")

    def write(self, event: str, item: dict) -> None:
        self.stream.write(json.dumps({"event": event, **item}, sort_keys=True) + "\n")
        self.stream.flush()

    def close(self) -> None:
        self.stream.close()
