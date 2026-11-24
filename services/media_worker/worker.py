"""OrbitSuite optional media service.

Polls the authenticated control Worker, downloads supported public media via
yt-dlp to a temporary directory, uploads it to Telegram, then erases the
temporary files. No account session is used. Never run as root.
"""
from __future__ import annotations

import ipaddress
from contextlib import ExitStack
import logging
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

from media_features import (
    LOCAL_BOT_API_UPLOAD_MAX, MAX_FILES, MAX_SPLIT_SOURCE_BYTES, ProgressReader, STANDARD_UPLOAD_MAX,
    embed_subtitles_args, ffmpeg_args, inspect_media, media_files, progress_event, rewrite_filename,
    run_download_command, run_media_command, safe_name, screenshot_args,
    split_file, thumbnail_args, validate_options,
)
from telegram_parts import join_telegram_parts
from telegram_transcribe import transcribe_telegram_audio

LOGGER = logging.getLogger("orbit.media")
MAX_BYTES = 45 * 1024 * 1024
DEFAULT_HOSTS = ("youtube.com", "youtu.be", "vimeo.com")
SOCIAL_HOSTS = ("instagram.com", "facebook.com", "fb.watch", "x.com",
                "twitter.com", "tiktok.com", "reddit.com", "soundcloud.com",
                "dailymotion.com", "bilibili.com")


class PartialDeliveryError(RuntimeError):
    """Telegram has received one or more files; blind retries would duplicate them."""


class MediaHeartbeat:
    """Refresh an active local worker claim during long media jobs.

    The Cloudflare control plane may not expose this optional endpoint; 404
    disables heartbeats without affecting the actual download/upload.
    """

    def __init__(self, client, control: str, headers: dict, job_id: int,
                 interval: int = 60):
        self.client = client
        self.control = control
        self.headers = headers
        self.job_id = job_id
        self.interval = interval
        self.stop = threading.Event()
        self.thread = None

    def tick(self) -> bool:
        try:
            response = self.client.post(self.control + "/internal/media/heartbeat",
                                        headers=self.headers, json={"id": self.job_id}, timeout=5)
            if response.status_code in (403, 404, 405, 409):
                return False  # Unsupported endpoint, lost claim, or auth mismatch.
            if response.status_code >= 400:
                LOGGER.warning("Media heartbeat status %d", response.status_code)
        except Exception as exc:
            LOGGER.warning("Media heartbeat unavailable: %s", type(exc).__name__)
        return True

    def _loop(self) -> None:
        while not self.stop.wait(self.interval):
            if not self.tick():
                break

    def __enter__(self):
        if self.interval > 0:
            self.thread = threading.Thread(target=self._loop, daemon=True,
                                           name="orbit-media-heartbeat")
            self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.stop.set()
        if self.thread is not None:
            self.thread.join(timeout=2)


class MediaProgressReporter:
    """Best-effort, throttled D1 progress telemetry; no token, URL or media data."""

    def __init__(self, client, control: str, headers: dict, job_id: int,
                 interval: int = 5):
        self.client = client
        self.control = control
        self.headers = headers
        self.job_id = job_id
        self.interval = interval
        self.previous = float("-inf")
        self.disabled = False

    def __call__(self, state: dict):
        if self.disabled:
            return
        now = time.monotonic()
        if now - self.previous < self.interval and state.get("stage") != "uploaded_file":
            return
        self.previous = now
        payload = {"id": self.job_id}
        for field in ("stage", "bytes", "total", "speed_bps", "eta_seconds", "done"):
            if field in state:
                payload[field] = state[field]
        try:
            response = self.client.post(self.control + "/internal/media/progress",
                                        headers=self.headers, json=payload, timeout=3)
            if response.status_code in (403, 404, 405, 409):
                self.disabled = True
            elif response.status_code >= 400:
                LOGGER.warning("Media progress status %d", response.status_code)
        except Exception as exc:
            LOGGER.warning("Media progress unavailable: %s", type(exc).__name__)


def allowed_host(hostname: str, allowed: tuple[str, ...]) -> bool:
    return any(hostname == item or hostname.endswith("." + item) for item in allowed)


def validate_url(url: str, allowed: tuple[str, ...] = DEFAULT_HOSTS) -> str:
    if not isinstance(url, str) or len(url) > 2048:
        raise ValueError("Invalid URL")
    parts = urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not host or parts.username or parts.password or parts.port:
        raise ValueError("Only public HTTPS URLs without embedded credentials are allowed")
    if not allowed_host(host, allowed):
        raise ValueError("Source host is not allowlisted")
    try:
        resolved = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError("Source hostname could not be resolved") from exc
    if not resolved or any(not ipaddress.ip_address(item[4][0]).is_global for item in resolved):
        raise ValueError("Source must resolve exclusively to public addresses")
    return url


def validate_control_url(url: str, allow_local_http: bool = False) -> str:
    """A local-only HTTP exception lets Docker/Termux avoid public TLS endpoints.

    Media source URLs continue to require public HTTPS and their own allowlist.
    """
    parts = urlsplit(url)
    if (parts.scheme == "https" and parts.hostname and not parts.username
            and not parts.password and not parts.query and not parts.fragment):
        return url.rstrip("/")
    if (allow_local_http and parts.scheme == "http"
            and parts.hostname in {"localhost", "127.0.0.1"}
            and parts.port == 8787 and not parts.username and not parts.password
            and not parts.query and not parts.fragment
            and parts.path in {"", "/"}):
        return url.rstrip("/")
    raise ValueError("Control URL must use HTTPS, or opted-in loopback HTTP on port 8787")


def validate_bot_api_base(raw: str, allow_local: bool = False) -> str:
    """Only Telegram's official API or an explicitly opted-in local Bot API."""
    parts = urlsplit(raw)
    if (parts.scheme == "https" and parts.hostname == "api.telegram.org"
            and not parts.username and not parts.password and not parts.port
            and parts.path in ("", "/") and not parts.query and not parts.fragment):
        return "https://api.telegram.org"
    if (allow_local and parts.scheme == "http" and
            parts.hostname in {"127.0.0.1", "localhost"} and
            parts.port == 8081 and parts.path in ("", "/") and
            not parts.username and not parts.password and
            not parts.query and not parts.fragment):
        return "http://127.0.0.1:8081"
    raise ValueError("Bot API must use api.telegram.org or explicitly enabled local loopback port 8081")


def yt_dlp_args(url: str, output_dir: Path, kind: str, quality: str | None = None,
                options: dict | None = None, progress: bool = False) -> list[str]:
    if kind not in {"video", "audio"}:
        raise ValueError("Invalid media kind")
    if quality is not None:
        valid = {"video": {"360", "480", "720", "1080"},
                 "audio": {"0", "2", "5", "7"}}
        if quality not in valid[kind]:
            raise ValueError("Invalid media quality")
    options = validate_options(options)
    playlist = options.get("playlist_limit")
    base = ["yt-dlp", "--ignore-config", "--no-cache-dir",
            "--no-warnings", "--restrict-filenames",
            "--max-filesize", str(options.get("max_bytes", MAX_BYTES)),
            "-o", str(output_dir / ("%(playlist_index)s_%(title).80s_%(id)s.%(ext)s"
                                     if playlist else "%(title).100s_%(id)s.%(ext)s"))]
    if progress:
        base.extend(["--newline", "--progress-template",
                     "download:ORBIT_PROGRESS:%(progress.downloaded_bytes)s:"
                     "%(progress.total_bytes)s:%(progress.total_bytes_estimate)s:"
                     "%(progress.speed)s:%(progress.eta)s"])
    if playlist:
        base.extend(["--yes-playlist", "--playlist-end", str(playlist)])
    else:
        base.append("--no-playlist")
    if options.get("subtitles") or options.get("embed_subtitles"):
        base.extend(["--write-subs", "--sub-langs", "en", "--sub-format", "srt/vtt/best"])
    if options.get("embed_metadata"):
        base.append("--embed-metadata")
    if kind == "audio":
        base += ["-x", "--audio-format", options.get("audio_format", "mp3"),
                 "--audio-quality", str(options["audio_bitrate"]) + "K"
                 if options.get("audio_bitrate") else quality or "5"]
    else:
        if options.get("container"):
            base += ["--merge-output-format", options["container"]]
        base += ["-f", "best[height<=" + quality + "]" if quality else "best[height<=1080]/best"]
    return base + ["--", url]


def choose_file(directory: Path) -> Path:
    found = [p for p in directory.iterdir() if p.is_file() and p.stat().st_size > 0]
    if len(found) != 1:
        raise ValueError("Media extraction did not produce exactly one file")
    if found[0].stat().st_size > MAX_BYTES:
        raise ValueError("Telegram Bot API upload size guard exceeded")
    return found[0]


def _process_core(job: dict, client, token: str, allowed: tuple[str, ...],
                  *, api_base: str, progress, delivery_state: dict) -> dict:
    options = validate_options(job.get("options"))
    sources = job.get("urls") if job.get("urls") is not None else [job["url"]]
    if not isinstance(sources, list) or not 1 <= len(sources) <= MAX_FILES:
        raise ValueError("A media job must contain 1-10 URLs")
    urls = [validate_url(url, allowed) for url in sources]
    local_api = validate_bot_api_base(api_base, True).startswith("http://")
    maximum = LOCAL_BOT_API_UPLOAD_MAX if local_api else STANDARD_UPLOAD_MAX
    download_limit = options.get("max_bytes", MAX_BYTES)
    if download_limit > MAX_SPLIT_SOURCE_BYTES:
        raise ValueError("Download size exceeds the maximum split-source limit")
    if download_limit > LOCAL_BOT_API_UPLOAD_MAX and (not local_api or not options.get("split")):
        raise ValueError("Sources above the local Bot API per-document limit require local split mode")
    if download_limit > maximum and not options.get("split"):
        raise ValueError("Large files require split mode or local Bot API")
    if not local_api and download_limit > MAX_FILES * STANDARD_UPLOAD_MAX:
        raise ValueError("Split uploads cannot exceed ten Telegram parts")
    if not shutil.which("yt-dlp"):
        raise RuntimeError("yt-dlp executable is missing")
    if job["kind"] == "audio" and not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is required for audio extraction")
    if job["kind"] == "audio" and any(key in options for key in
            ("trim_start", "trim_duration", "crop", "rotate", "height",
             "compress_crf", "watermark", "thumbnail", "screenshot_at", "embed_subtitles",
             "video_codec", "container")):
        raise ValueError("Video processing options are unavailable for audio jobs")
    if job["kind"] == "video" and any(key in options for key in ("audio_format", "audio_bitrate")):
        raise ValueError("Audio extraction options are unavailable for video jobs")
    if any(key in options for key in ("trim_start", "trim_duration", "crop", "rotate",
                                       "height", "compress_crf", "watermark", "thumbnail",
                                       "screenshot_at", "embed_metadata", "embed_subtitles",
                                       "video_codec", "container")) and not shutil.which("ffmpeg"):
        raise RuntimeError("FFmpeg is required for selected media operations")
    if options.get("ffprobe") and not shutil.which("ffprobe"):
        raise RuntimeError("ffprobe is required for metadata inspection")
    receipts = []
    subtitles_uploaded = 0
    subtitles_skipped = 0
    processed_count = 0
    with tempfile.TemporaryDirectory(prefix="orbit-media-") as folder:
        directory = Path(folder)
        for source_number, url in enumerate(urls, start=1):
            extraction = directory / ("extract_%02d" % source_number)
            extraction.mkdir()
            command = yt_dlp_args(url, extraction, job["kind"], job.get("quality"),
                                  {**options, "max_bytes": download_limit},
                                  progress=progress is not None)
            if progress:
                progress(progress_event("download_started", source_number, len(urls)))
                run_download_command(command, progress)
            else:
                run_media_command(command)
            files = media_files(extraction, download_limit)
            if processed_count + len(files) > MAX_FILES:
                raise ValueError("Media job exceeds ten output files")
            for raw_file in files:
                processed_count += 1
                media_path = raw_file
                thumb = None
                screenshot = None
                metadata = None
                workdir = directory / ("work_%02d" % processed_count)
                workdir.mkdir()
                transforms = ("trim_start", "trim_duration", "crop", "rotate", "height",
                              "compress_crf", "watermark", "video_codec", "container")
                if job["kind"] == "video" and any(key in options for key in transforms):
                    media_path = workdir / ("transformed." + options.get("container", "mp4"))
                    run_media_command(ffmpeg_args(raw_file, media_path, options))
                if job["kind"] == "video" and options.get("embed_subtitles"):
                    subtitles_to_embed = sorted(
                        (p for p in extraction.iterdir()
                         if p.is_file() and not p.is_symlink()
                         and p.suffix.lower() in {".srt", ".vtt"}
                         and 0 < p.stat().st_size <= 1024 * 1024),
                        key=lambda p: (p.suffix.lower() != ".srt", p.name))
                    if not subtitles_to_embed:
                        raise ValueError("No English subtitle sidecar was available to embed")
                    subtitled = workdir / "subtitled.mp4"
                    run_media_command(embed_subtitles_args(media_path, subtitles_to_embed[0], subtitled))
                    media_path = subtitled
                if options.get("thumbnail") and job["kind"] == "video":
                    thumb = workdir / "thumbnail.jpg"
                    run_media_command(thumbnail_args(media_path, thumb,
                                                     options.get("thumbnail_at", 0)), timeout=180)
                    if thumb.stat().st_size > 200 * 1024:
                        thumb = None  # Telegram ignores thumbnails over 200 KB.
                if "screenshot_at" in options and job["kind"] == "video":
                    screenshot = workdir / "screenshot.jpg"
                    run_media_command(screenshot_args(media_path, screenshot,
                                                      options["screenshot_at"]), timeout=180)
                if options.get("ffprobe"):
                    metadata = inspect_media(media_path)
                size = media_path.stat().st_size
                if size > download_limit:
                    raise ValueError("Processed media exceeds download limit")
                if size > maximum:
                    if not options.get("split"):
                        raise ValueError("Processed file exceeds upload limit")
                    upload_paths = split_file(media_path, workdir / "parts", maximum)
                else:
                    upload_paths = [media_path]
                if len(receipts) + len(upload_paths) > MAX_FILES:
                    raise ValueError("Media job exceeds ten Telegram documents")
                caption = options.get("caption", "")
                for old, new in options.get("replacements", []):
                    caption = caption.replace(old, new)
                caption = caption[:1024]
                for part_number, upload_path in enumerate(upload_paths, start=1):
                    filename = rewrite_filename(raw_file.name, options,
                                                extension="" if len(upload_paths) > 1 else None)
                    if len(upload_paths) > 1:
                        filename = filename + ".part%03d" % part_number
                    payload = {"chat_id": str(job["dest"]),
                               "disable_notification": "true"}
                    if int(job.get("dest_topic") or 0):
                        payload["message_thread_id"] = str(job["dest_topic"])
                    if caption:
                        payload["caption"] = caption
                    with ExitStack() as stack:
                        stream = stack.enter_context(upload_path.open("rb"))
                        wrapped = ProgressReader(stream, upload_path.stat().st_size, progress)
                        multipart = {"document": (filename, wrapped,
                                                  "application/octet-stream")}
                        if thumb and len(upload_paths) == 1:
                            multipart["thumbnail"] = ("thumbnail.jpg",
                                                      stack.enter_context(thumb.open("rb")), "image/jpeg")
                        response = client.post(api_base + "/bot" + token + "/sendDocument",
                                               data=payload, files=multipart, timeout=300)
                    data = response.json()
                    if not data.get("ok"):
                        raise RuntimeError("Telegram rejected upload (API " +
                                           str(data.get("error_code") or response.status_code) + ")")
                    receipts.append({"message_id": data.get("result", {}).get("message_id"),
                                     "name": filename, "size": upload_path.stat().st_size,
                                     "metadata": metadata})
                    delivery_state["sent"] += 1
                    if progress:
                        progress(progress_event("uploaded_file", len(receipts), MAX_FILES))
                    time.sleep(1)  # Conservative per-chat spacing for account safety.
                if screenshot:
                    with screenshot.open("rb") as image_stream:
                        response = client.post(api_base + "/bot" + token + "/sendPhoto",
                            data={"chat_id": str(job["dest"]),
                                  **({"message_thread_id": str(job["dest_topic"])} if job.get("dest_topic") else {})},
                            files={"photo": ("screenshot.jpg", image_stream, "image/jpeg")},
                            timeout=300)
                    if not response.json().get("ok"):
                        raise RuntimeError("Screenshot upload failed; check destination before retry")
                    delivery_state["sent"] += 1
            if options.get("subtitles"):
                subtitles = sorted(p for p in extraction.iterdir()
                                   if p.suffix.lower() in {".srt", ".vtt"}
                                   and p.is_file() and not p.is_symlink()
                                   and 0 < p.stat().st_size <= 1024 * 1024)
                for subtitle in subtitles:
                    if len(receipts) >= MAX_FILES:
                        subtitles_skipped += 1
                        continue
                    payload = {"chat_id": str(job["dest"]),
                               "disable_notification": "true",
                               "caption": "English subtitles"}
                    if int(job.get("dest_topic") or 0):
                        payload["message_thread_id"] = str(job["dest_topic"])
                    with subtitle.open("rb") as stream:
                        response = client.post(api_base + "/bot" + token + "/sendDocument",
                            data=payload,
                            files={"document": (safe_name(subtitle.name),
                                ProgressReader(stream, subtitle.stat().st_size, progress),
                                "text/plain")}, timeout=300)
                    if not response.json().get("ok"):
                        raise RuntimeError("Subtitle upload failed; check destination before retry")
                    receipts.append({"message_id": response.json().get("result", {}).get("message_id"),
                                     "name": safe_name(subtitle.name),
                                     "size": subtitle.stat().st_size, "type": "subtitle"})
                    delivery_state["sent"] += 1
                    subtitles_uploaded += 1
                    time.sleep(1)
    return {"uploaded": len(receipts), "files": receipts,
            "subtitles_uploaded": subtitles_uploaded,
            "subtitles_skipped": subtitles_skipped}


def process(job: dict, client, token: str, allowed: tuple[str, ...],
            *, api_base: str = "https://api.telegram.org", progress=None,
            model_root: str | None = None, model_name: str | None = None) -> dict:
    delivery_state = {"sent": 0}
    try:
        if job.get("task") == "transcribe":
            return transcribe_telegram_audio(job, client, token, api_base,
                model_root=model_root or os.environ.get("ORBIT_WHISPER_MODEL_ROOT", ""),
                model_name=model_name or os.environ.get("ORBIT_WHISPER_MODEL", ""))
        if job.get("parts") is not None:
            return join_telegram_parts(job, client, token, api_base, progress)
        return _process_core(job, client, token, allowed,
                             api_base=api_base, progress=progress,
                             delivery_state=delivery_state)
    except (RuntimeError, ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
        if delivery_state["sent"]:
            raise PartialDeliveryError("Some Telegram files were delivered; do not retry blindly") from exc
        raise


def run() -> None:
    try:
        import httpx
    except ImportError as exc:
        raise SystemExit("Install dependencies: pip install -r requirements.txt") from exc
    control = os.environ.get("ORBIT_CONTROL_URL", "").rstrip("/")
    key = os.environ.get("ORBIT_SERVICE_KEY", "")
    token = os.environ.get("BOT_TOKEN", "")
    hosts = tuple(x.strip().lower() for x in
                  os.environ.get("ORBIT_MEDIA_HOSTS", ",".join(DEFAULT_HOSTS)).split(",") if x.strip())
    if os.environ.get("ORBIT_ALLOW_SOCIAL_HOSTS") == "1":
        hosts += SOCIAL_HOSTS
    if len(key) < 24 or not token or not hosts:
        raise SystemExit("Set ORBIT_CONTROL_URL, ORBIT_SERVICE_KEY, BOT_TOKEN, and allowed hosts")
    try:
        control = validate_control_url(control,
            os.environ.get("ORBIT_ALLOW_LOCAL_HTTP") == "1")
        api_base = validate_bot_api_base(
            os.environ.get("ORBIT_TELEGRAM_API_BASE", "https://api.telegram.org"),
            os.environ.get("ORBIT_ALLOW_LOCAL_BOT_API") == "1")
    except ValueError as exc:
        raise SystemExit(str(exc)) from exc
    interval = max(10, min(300, int(os.environ.get("ORBIT_POLL_SECONDS", "30"))))
    heartbeat_seconds = int(os.environ.get("ORBIT_MEDIA_HEARTBEAT_SECONDS", "60"))
    if heartbeat_seconds:
        heartbeat_seconds = max(30, min(300, heartbeat_seconds))
    headers = {"X-Orbit-Service-Key": key}
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    # HTTP clients may otherwise log the bot token embedded in API URLs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    with httpx.Client(timeout=30, follow_redirects=False) as client, \
         httpx.Client(timeout=5, follow_redirects=False) as telemetry_client:
        while True:
            try:
                claim = client.post(control + "/internal/media/claim",
                                    headers=headers, json={})
                claim.raise_for_status()
                job = claim.json().get("job")
                if job:
                    # Upload timeouts are ambiguous: never assume a retry is safe.
                    status, error = "done", ""
                    try:
                        reporter = (MediaProgressReporter(telemetry_client, control,
                                    headers, job["id"])
                                    if os.environ.get("ORBIT_MEDIA_PROGRESS", "1") == "1"
                                    else None)
                        with MediaHeartbeat(telemetry_client, control, headers,
                                            job["id"], interval=heartbeat_seconds):
                            process(job, client, token, hosts, api_base=api_base,
                                    progress=reporter,
                                    model_root=os.environ.get("ORBIT_WHISPER_MODEL_ROOT"),
                                    model_name=os.environ.get("ORBIT_WHISPER_MODEL"))
                    except PartialDeliveryError:
                        status, error = "uncertain", "Some files delivered; inspect destination before retry"
                    except (httpx.TimeoutException, httpx.TransportError):
                        status, error = "uncertain", "Telegram upload result unknown"
                    except (RuntimeError, ValueError, OSError, KeyError, TypeError, AttributeError) as exc:
                        status, error = "failed", type(exc).__name__
                    result = client.post(control + "/internal/media/result",
                        headers=headers,
                        json={"id": job["id"], "status": status, "error": error})
                    result.raise_for_status()
                    LOGGER.info("media job %s: %s", job["id"], status)
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                LOGGER.warning("Control plane request failed: %s", type(exc).__name__)
            time.sleep(interval)


if __name__ == "__main__":
    run()
