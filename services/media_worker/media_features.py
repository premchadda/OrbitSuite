"""Bounded media-processing primitives for OrbitSuite's optional Python worker.

No account sessions, arbitrary commands, unmanaged file persistence, or remote
filter expressions. All output paths are selected inside caller-owned temporary
directories. The Bot API determines the ultimate file-size ceiling.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import select
import shutil
import subprocess
import time
from typing import Callable, Iterable


STANDARD_UPLOAD_MAX = 45 * 1024 * 1024
LOCAL_BOT_API_UPLOAD_MAX = 1900 * 1024 * 1024
MAX_SPLIT_SOURCE_BYTES = 4 * 1024 * 1024 * 1024
MAX_FILES = 10
VIDEO_HEIGHTS = {360, 480, 720, 1080}
MEDIA_EXTENSIONS = {
    ".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".3gp", ".ts",
    ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".flac", ".wav", ".wma",
}
SAFE_FILENAME = re.compile(r"[^a-zA-Z0-9._ -]")
CHUNK = 4 * 1024 * 1024


def validate_options(raw: dict | None) -> dict:
    """Normalize the only options accepted from a media job.

    Rejecting unknown keys is deliberate: otherwise upstream wrappers might
    accidentally pass dangerous yt-dlp/FFmpeg arguments through.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError("Media options must be an object")
    allowed = {
        "playlist_limit", "caption", "filename", "replacements", "trim_start",
        "trim_duration", "crop", "rotate", "height", "compress_crf",
        "thumbnail_at", "thumbnail", "subtitles", "embed_subtitles", "watermark", "split",
        "ffprobe", "screenshot_at", "embed_metadata", "max_bytes",
        "audio_format", "audio_bitrate", "video_codec", "container",
    }
    if set(raw) - allowed:
        raise ValueError("Unsupported media option")
    options = dict(raw)
    if "playlist_limit" in options:
        if type(options["playlist_limit"]) is not int or not 1 <= options["playlist_limit"] <= MAX_FILES:
            raise ValueError("Playlist limit must be 1-10")
    if "max_bytes" in options:
        if (type(options["max_bytes"]) is not int
                or not 1024 <= options["max_bytes"] <= MAX_SPLIT_SOURCE_BYTES):
            raise ValueError("Invalid media download size limit")
    for key, maximum in (("caption", 1024), ("filename", 128), ("watermark", 60)):
        if key in options and (not isinstance(options[key], str)
                or not options[key] or len(options[key]) > maximum
                or any(ord(char) < 32 for char in options[key])):
            raise ValueError("Invalid " + key)
    if "filename" in options:
        if any(char in "/\\" for char in options["filename"]):
            raise ValueError("Filename cannot contain directory separators")
        options["filename"] = safe_name(options["filename"])
    replacements = options.get("replacements", [])
    if not isinstance(replacements, list) or len(replacements) > 8:
        raise ValueError("Invalid filename replacements")
    for item in replacements:
        if (not isinstance(item, list) or len(item) != 2 or
                any(not isinstance(x, str) or len(x) > 64 for x in item)
                or not item[0]):
            raise ValueError("Invalid filename replacement pair")
    for key, maximum in (("trim_start", 86400), ("trim_duration", 21600),
                         ("thumbnail_at", 86400), ("screenshot_at", 86400)):
        if key in options and (type(options[key]) not in (int, float)
                or not 0 <= options[key] <= maximum):
            raise ValueError("Invalid " + key)
    if "trim_duration" in options and options["trim_duration"] <= 0:
        raise ValueError("trim_duration must be positive")
    if "crop" in options:
        crop = options["crop"]
        if (not isinstance(crop, list) or len(crop) != 4
                or any(type(x) is not int or x < 0 or x > 8192 for x in crop)
                or crop[2] < 2 or crop[3] < 2):
            raise ValueError("Crop must be [x, y, width, height]")
    if "height" in options and (type(options["height"]) is not int
                               or options["height"] not in VIDEO_HEIGHTS):
        raise ValueError("Unsupported output height")
    if "rotate" in options and (type(options["rotate"]) is not int
                               or options["rotate"] not in (90, 180, 270)):
        raise ValueError("Rotation must be 90/180/270")
    for key, choices in (("audio_format", {"mp3", "m4a", "opus"}),
                         ("video_codec", {"h264", "h265"}),
                         ("container", {"mp4", "mkv"})):
        if key in options and (not isinstance(options[key], str)
                               or options[key] not in choices):
            raise ValueError("Invalid codec/format option " + key)
    if "audio_bitrate" in options and (type(options["audio_bitrate"]) is not int
                                       or options["audio_bitrate"] not in {64, 96, 128, 192, 256, 320}):
        raise ValueError("Audio bitrate must be one of 64/96/128/192/256/320 kbps")
    if "compress_crf" in options and (type(options["compress_crf"]) is not int
                                     or not 18 <= options["compress_crf"] <= 35):
        raise ValueError("CRF must be between 18 and 35")
    for key in ("thumbnail", "subtitles", "embed_subtitles", "split", "ffprobe", "embed_metadata"):
        if key in options and type(options[key]) is not bool:
            raise ValueError("Invalid boolean option " + key)
    if "watermark" in options and any(char in "/\\:" for char in options["watermark"]):
        raise ValueError("Unsupported watermark characters")
    return options


def safe_name(name: str) -> str:
    if not isinstance(name, str):
        raise ValueError("Invalid filename")
    name = SAFE_FILENAME.sub("_", name).strip(" .")[:128]
    if not name or name in {".", ".."}:
        raise ValueError("Empty filename")
    return name


def rewrite_filename(original: str, options: dict, extension: str | None = None) -> str:
    result = options.get("filename") or Path(original).stem
    for old, new in options.get("replacements", []):
        result = result.replace(old, new)
    suffix = Path(original).suffix if extension is None else extension
    if suffix and (not re.fullmatch(r"\.[A-Za-z0-9]{1,8}", suffix)):
        raise ValueError("Invalid file extension")
    if suffix and result.lower().endswith(suffix.lower()):
        result = result[:-len(suffix)]
    result = safe_name(result)
    return result[:110] + suffix


def media_files(directory: Path, max_bytes: int = STANDARD_UPLOAD_MAX,
                max_files: int = MAX_FILES) -> list[Path]:
    """Only regular files from one controlled temp dir; sidecars excluded."""
    found = sorted((p for p in directory.iterdir()
                    if p.is_file() and not p.is_symlink()
                    and p.suffix.lower() in MEDIA_EXTENSIONS),
                   key=lambda p: p.name)
    if not found or len(found) > max_files:
        raise ValueError("Expected 1-10 nonempty media files")
    if any(p.stat().st_size < 1 or p.stat().st_size > max_bytes for p in found):
        raise ValueError("A media file exceeded the configured limit")
    return found


def split_file(source: Path, destination: Path, part_bytes: int = STANDARD_UPLOAD_MAX) -> list[Path]:
    if part_bytes < 1024 or part_bytes > LOCAL_BOT_API_UPLOAD_MAX:
        raise ValueError("Invalid split chunk size")
    if not source.is_file() or source.is_symlink() or destination.resolve() == source.parent.resolve():
        raise ValueError("Split input/output must be separate controlled directories")
    size = source.stat().st_size
    count = (size + part_bytes - 1) // part_bytes
    if not 1 <= count <= MAX_FILES:
        raise ValueError("File requires too many parts")
    destination.mkdir(mode=0o700, exist_ok=True)
    parts = []
    with source.open("rb") as handle:
        for part_no in range(1, count + 1):
            part = destination / (safe_name(source.name) + ".part%03d" % part_no)
            with part.open("xb") as output:
                remaining = min(part_bytes, size - (part_no - 1) * part_bytes)
                while remaining:
                    chunk = handle.read(min(CHUNK, remaining))
                    if not chunk:
                        raise OSError("Unexpected end of split file")
                    output.write(chunk)
                    remaining -= len(chunk)
            parts.append(part)
    return parts


def join_parts(parts: Iterable[Path], destination: Path, max_bytes: int = LOCAL_BOT_API_UPLOAD_MAX) -> Path:
    files = list(parts)
    if not 1 <= len(files) <= MAX_FILES or len({p.resolve() for p in files}) != len(files):
        raise ValueError("Invalid part count")
    if any(not p.is_file() or p.is_symlink() for p in files):
        raise ValueError("Only regular part files are supported")
    if not all(re.fullmatch(r".+\.part\d{3}", p.name) for p in files):
        raise ValueError("Invalid part filename")
    basenames = {p.name.rsplit(".part", 1)[0] for p in files}
    directories = {p.parent.resolve() for p in files}
    if len(basenames) != 1 or len(directories) != 1:
        raise ValueError("Parts must share filename and directory")
    expected_names = [next(iter(basenames)) + ".part%03d" % n for n in range(1, len(files) + 1)]
    if [p.name for p in files] != expected_names:
        raise ValueError("Parts must be ordered and contiguous")
    if destination.exists() or destination.parent.resolve() == next(iter(directories)):
        raise ValueError("Output cannot overwrite parts")
    if sum(p.stat().st_size for p in files) > max_bytes:
        raise ValueError("Reassembled file exceeds limit")
    with destination.open("xb") as output:
        for part in files:
            with part.open("rb") as source:
                shutil.copyfileobj(source, output, length=CHUNK)
    return destination


def ffmpeg_filters(options: dict, directory: Path | None = None) -> list[str]:
    filters = []
    if "crop" in options:
        x, y, width, height = options["crop"]
        filters.append(f"crop={width}:{height}:{x}:{y}")
    if options.get("rotate") == 90:
        filters.append("transpose=1")
    elif options.get("rotate") == 180:
        filters.extend(["hflip", "vflip"])
    elif options.get("rotate") == 270:
        filters.append("transpose=2")
    if options.get("height"):
        filters.append("scale=-2:" + str(options["height"]))
    if options.get("watermark"):
        if directory is None:
            raise ValueError("Watermark needs a controlled temporary directory")
        marker = directory / "owner_watermark.txt"
        marker.write_text(options["watermark"], encoding="utf8")
        filters.append("drawtext=textfile=" + str(marker) +
                       ":fontcolor=white:fontsize=20:x=w-tw-16:y=h-th-16")
    return filters


def ffmpeg_args(source: Path, output: Path, options: dict) -> list[str]:
    """A fixed command schema, not arbitrary FFmpeg arguments."""
    validate_options(options)
    if not options or not any(key in options for key in (
            "trim_start", "trim_duration", "crop", "rotate", "height",
            "compress_crf", "watermark", "video_codec", "container")):
        raise ValueError("No video transform requested")
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if options.get("trim_start"):
        command.extend(["-ss", str(options["trim_start"])])
    command.extend(["-i", str(source)])
    if options.get("trim_duration"):
        command.extend(["-t", str(options["trim_duration"])])
    filters = ffmpeg_filters(options, output.parent)
    if filters:
        command.extend(["-vf", ",".join(filters)])
    command.extend(["-c:v", "libx265" if options.get("video_codec") == "h265" else "libx264",
                    "-preset", "veryfast",
                    "-crf", str(options.get("compress_crf", 26)),
                    "-c:a", "aac", "-movflags", "+faststart", str(output)])
    return command


def embed_subtitles_args(source: Path, subtitle: Path, output: Path) -> list[str]:
    """Safely mux a fetched English SRT/VTT subtitle into MP4 as mov_text."""
    if subtitle.suffix.lower() not in {".srt", ".vtt"} or output.suffix.lower() != ".mp4":
        raise ValueError("Only SRT/VTT to MP4 subtitle embedding is supported")
    if source.resolve() == output.resolve() or subtitle.resolve() == output.resolve():
        raise ValueError("Subtitle mux output must be a separate file")
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-i", str(source), "-i", str(subtitle), "-map", "0:v:0",
            "-map", "0:a?", "-map", "1:0", "-c:v", "copy", "-c:a", "copy",
            "-c:s", "mov_text", "-metadata:s:s:0", "language=eng",
            "-movflags", "+faststart", str(output)]


def thumbnail_args(source: Path, output: Path, seconds: float) -> list[str]:
    if not isinstance(seconds, (int, float)) or not 0 <= seconds <= 86400:
        raise ValueError("Invalid thumbnail timestamp")
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-ss", str(seconds), "-i", str(source), "-frames:v", "1",
            "-vf", "scale=320:-2", str(output)]


def screenshot_args(source: Path, output: Path, seconds: float) -> list[str]:
    """Extract a readable, bounded still instead of a tiny thumbnail."""
    if type(seconds) not in (int, float) or not 0 <= seconds <= 86400:
        raise ValueError("Invalid screenshot timestamp")
    return ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-ss", str(seconds), "-i", str(source), "-frames:v", "1",
            "-vf", "scale=trunc(min(1280\\,iw)/2)*2:-2", str(output)]


def ffprobe_args(source: Path) -> list[str]:
    return ["ffprobe", "-v", "error", "-show_entries",
            "format=duration,size:stream=codec_name,codec_type,width,height",
            "-of", "json", str(source)]


def inspect_media(source: Path, executor=subprocess.run) -> dict:
    result = executor(ffprobe_args(source), check=True, capture_output=True,
                      text=True, timeout=20, shell=False)
    if len(result.stdout) > 32000:
        raise ValueError("Too much media metadata")
    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    if len(streams) > 16:
        raise ValueError("Too many media streams")
    return {"format": data.get("format", {}), "streams": streams}


def run_media_command(args: list[str], *, timeout: int = 1200,
                      executor=subprocess.run) -> None:
    try:
        executor(args, check=True, timeout=timeout, capture_output=True,
                 text=True, shell=False)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
        # Do not show stderr, which can contain signed URLs or private metadata.
        raise RuntimeError("Media conversion failed or timed out") from exc


def parse_download_progress(line: str) -> dict | None:
    """Parse only a private machine-readable yt-dlp marker, never source URLs."""
    marker = "ORBIT_PROGRESS:"
    if marker not in line:
        return None
    fields = line.rsplit(marker, 1)[1].strip().split(":")
    if len(fields) != 5:
        return None
    downloaded, exact, estimated, speed, eta = fields
    try:
        done = int(downloaded)
        total = next((int(value) for value in (exact, estimated)
                      if value not in ("NA", "None", "")), None)
        rate = float(speed) if speed not in ("NA", "None", "") else None
        remaining = float(eta) if eta not in ("NA", "None", "") else None
    except (ValueError, OverflowError):
        return None
    if done < 0 or (total is not None and total < 0):
        return None
    return {"stage": "download", "bytes": done,
            "total": max(done, total) if total is not None else None,
            "speed_bps": max(0, round(rate)) if rate is not None and 0 <= rate < 1e12 else None,
            "eta_seconds": max(0, round(remaining)) if remaining is not None
                           and 0 <= remaining < 1e8 else None}


def run_download_command(args: list[str], callback: Callable, *, timeout: int = 1200) -> None:
    """Stream bounded yt-dlp progress without exposing command output or URLs.

    Timeout is absolute even if yt-dlp stalls without writing progress. This
    deliberately uses fixed argv and never uses a shell.
    """
    if not args or args[0] != "yt-dlp":
        raise ValueError("Only yt-dlp is supported by download progress runner")
    started = time.monotonic()
    with subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL, shell=False) as proc:
        try:
            fragment = b""
            while True:
                if time.monotonic() - started > timeout:
                    raise RuntimeError("Media download timed out")
                readable, _, _ = select.select([proc.stdout], [], [], 1)
                if not readable:
                    continue
                chunk = os.read(proc.stdout.fileno(), 4096)
                if not chunk:
                    break
                fragment += chunk
                if len(fragment) > 16384:
                    fragment = fragment[-8192:]
                lines = re.split(b"[\r\n]", fragment)
                fragment = lines.pop()
                for line in lines:
                    state = parse_download_progress(line.decode("utf-8", errors="replace"))
                    if state:
                        callback(state)
            remaining = max(0.001, timeout - (time.monotonic() - started))
            if proc.wait(timeout=remaining) != 0:
                raise RuntimeError("Media download failed")
        except subprocess.TimeoutExpired as exc:
            raise RuntimeError("Media download timed out") from exc
        finally:
            if proc.poll() is None:
                proc.kill()
                proc.wait(timeout=5)


class ProgressReader:
    """Tracks uploaded bytes as the multipart encoder reads, without logging tokens."""

    def __init__(self, stream, total: int, callback: Callable | None = None):
        self.stream = stream
        self.total = total
        self.callback = callback
        self.started = time.monotonic()
        self.last = 0.0
        self.bytes = 0

    def read(self, size=-1):
        chunk = self.stream.read(size)
        self.bytes += len(chunk)
        now = time.monotonic()
        if self.callback and (now - self.last >= 1 or self.bytes >= self.total):
            elapsed = max(0.001, now - self.started)
            self.callback({"stage": "upload", "bytes": self.bytes,
                           "total": self.total, "speed_bps": round(self.bytes / elapsed),
                           "eta_seconds": max(0, round((self.total - self.bytes) /
                                                       max(1, self.bytes / elapsed)))})
            self.last = now
        return chunk

    def __getattr__(self, key):
        return getattr(self.stream, key)


def progress_event(stage: str, done: int, total: int | None = None) -> dict:
    if (not isinstance(stage, str) or not stage.isascii() or len(stage) > 32
            or any(ord(char) < 32 for char in stage)):
        raise ValueError("Invalid progress stage")
    if (type(done) is not int or (total is not None and type(total) is not int)
            or done < 0 or (total is not None and (total < 0 or done > total))):
        raise ValueError("Invalid progress value")
    return {"stage": stage, "done": int(done), "total": total}
