"""Hermetic tests: no external downloader, FFmpeg or Telegram account needed."""
import io
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from media_features import (
    MAX_FILES, MAX_SPLIT_SOURCE_BYTES, ProgressReader, ffmpeg_args, ffmpeg_filters, ffprobe_args,
    inspect_media, join_parts, media_files, parse_download_progress,
    progress_event, rewrite_filename, safe_name, screenshot_args, split_file, thumbnail_args,
    validate_options, run_media_command,
)
from worker import (
    DEFAULT_HOSTS, MediaHeartbeat, MediaProgressReporter,
    PartialDeliveryError, SOCIAL_HOSTS, process, validate_bot_api_base,
    yt_dlp_args,
)


class MediaOptionTests(unittest.TestCase):
    def test_options_accept_supported_bounded_operations(self):
        options = {
            "playlist_limit": 10, "subtitles": True, "thumbnail": True,
            "crop": [1, 2, 500, 600], "height": 720, "rotate": 90,
            "compress_crf": 29, "trim_start": 1.5, "trim_duration": 25,
            "watermark": "My own footage", "split": True,
            "replacements": [["Old", "New"]], "max_bytes": 100_000_000,
        }
        self.assertEqual(validate_options(options), options)
        self.assertEqual(options["playlist_limit"], MAX_FILES)

    def test_unrecognized_and_unsafe_options_are_rejected(self):
        invalid = [
            {"yt_dlp_args": ["--exec", "touch /tmp/hacked"]},
            {"ffmpeg_args": "-i /etc/passwd"}, {"max_bytes": False},
            {"max_bytes": 1}, {"max_bytes": 10**15},
            {"playlist_limit": True}, {"playlist_limit": 11},
            {"subtitles": "yes"}, {"filename": "../"},
            {"watermark": "/etc/passwd"}, {"caption": "line\nmore"},
            {"trim_start": -1}, {"trim_duration": 0},
            {"rotate": 91}, {"height": 999},
            {"crop": [0, 0, 0, 100]}, {"compress_crf": 90},
            {"replacements": [["", "value"]]},
            {"replacements": [["a", "b", "c"]]},
            {"audio_format": "evil"}, {"audio_bitrate": 3200},
            {"video_codec": "arbitrary-command"}, {"container": "avi"},
        ]
        for entry in invalid:
            with self.subTest(entry=entry), self.assertRaises(ValueError):
                validate_options(entry)

    def test_filename_rewrites_and_no_path_traversal(self):
        sanitized = safe_name("../../unsafe🚨.mp4")
        self.assertNotIn("/", sanitized)
        self.assertNotIn("\\", sanitized)
        self.assertFalse(sanitized.startswith(".."))
        self.assertEqual(
            rewrite_filename("Old clip.mp4", {"replacements": [["Old", "New"]]}),
            "New clip.mp4",
        )
        self.assertEqual(
            rewrite_filename("clip.mp4", {"filename": "custom.mp4"}),
            "custom.mp4",
        )
        self.assertEqual(
            rewrite_filename("clip.mp4", {"filename": "custom"}, extension=""),
            "custom",
        )
        with self.assertRaises(ValueError):
            rewrite_filename("clip.mp4", {}, extension=".evil/name")

    def test_progress_and_eta_from_upload_reader(self):
        updates = []
        original = io.BytesIO(b"12" * 20)
        wrapped = ProgressReader(original, 40, updates.append)
        self.assertEqual(wrapped.read(10), b"12" * 5)
        self.assertEqual(wrapped.read(), b"12" * 15)
        self.assertEqual(updates[-1]["bytes"], 40)
        self.assertEqual(updates[-1]["eta_seconds"], 0)
        self.assertGreaterEqual(updates[-1]["speed_bps"], 0)
        self.assertEqual(progress_event("download", 1, 3),
                         {"stage": "download", "done": 1, "total": 3})
        with self.assertRaises(ValueError):
            progress_event("bad\nname", 1)
        with self.assertRaises(ValueError):
            progress_event("ok", 5, 1)

    @unittest.skipUnless(importlib.util.find_spec("httpx"), "httpx unavailable")
    def test_progress_reader_is_compatible_with_httpx_multipart(self):
        import httpx

        received = []
        states = []

        def handler(request):
            received.append(request.read())
            return httpx.Response(200, json={"ok": True})

        content = io.BytesIO(b"abcdefgh" * 2000)
        wrapped = ProgressReader(content, 16000, states.append)
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            response = client.post("https://api.telegram.org/botTEST/sendDocument",
                data={"chat_id": "1"},
                files={"document": ("original.mp4", wrapped, "application/octet-stream")})
        self.assertEqual(response.status_code, 200)
        self.assertIn(b"original.mp4", received[0])
        self.assertIn(b"abcdefgh", received[0])
        self.assertEqual(states[-1]["bytes"], 16000)

    def test_download_progress_discards_unstructured_yt_dlp_logs(self):
        self.assertIsNone(parse_download_progress("yt-dlp https://some-private-url"))
        state = parse_download_progress(
            "[download] ORBIT_PROGRESS:1024:2048:NA:512:2")
        self.assertEqual(state, {"stage": "download", "bytes": 1024,
                                 "total": 2048, "speed_bps": 512,
                                 "eta_seconds": 2})
        estimate = parse_download_progress("ORBIT_PROGRESS:50:NA:100:NA:NA")
        self.assertEqual(estimate["total"], 100)
        self.assertIsNone(estimate["eta_seconds"])
        self.assertIsNone(parse_download_progress("ORBIT_PROGRESS:oops:500:NA:NA:NA"))


class FileTests(unittest.TestCase):
    def test_split_and_join_are_byte_identical(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "original.dat"
            data = bytes(range(256)) * 40
            source.write_bytes(data)
            parts = split_file(source, root / "parts", 1024)
            self.assertEqual(len(parts), 10)
            self.assertTrue(all(0 < p.stat().st_size <= 1024 for p in parts))
            result = join_parts(parts, root / "joined.dat")
            self.assertEqual(result.read_bytes(), data)
            with self.assertRaises(ValueError):
                join_parts(parts[::-1], root / "another.dat")

    def test_opt_in_local_server_large_chunk_and_four_gib_split_source_limits(self):
        self.assertEqual(validate_options({"split": True, "max_bytes": MAX_SPLIT_SOURCE_BYTES})
                         ["max_bytes"], MAX_SPLIT_SOURCE_BYTES)
        with self.assertRaises(ValueError):
            validate_options({"max_bytes": MAX_SPLIT_SOURCE_BYTES + 1})
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "test.mp4"
            source.write_bytes(b"only a tiny boundary fixture")
            # Previously rejected because it was above the public 45 MiB limit.
            parts = split_file(source, root / "large-parts", 100 * 1024 * 1024)
            self.assertEqual(len(parts), 1)
            self.assertEqual(parts[0].read_bytes(), source.read_bytes())

    def test_noncontiguous_or_mixed_parts_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            parts = root / "parts"
            parts.mkdir()
            a = parts / "file.mp4.part001"
            b = parts / "file.mp4.part003"
            a.write_bytes(b"a")
            b.write_bytes(b"b")
            with self.assertRaises(ValueError):
                join_parts([a, b], root / "joined.mp4")
            with self.assertRaises(ValueError):
                join_parts([a, a], root / "joined.mp4")
            with self.assertRaises(ValueError):
                split_file(a, parts / "other", 1)

    def test_sidecars_and_symlinks_never_uploaded_as_media(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            valid = root / "media.mp4"
            valid.write_bytes(b"abcd")
            (root / "media.en.srt").write_text("hello")
            (root / "media.jpg").write_bytes(b"image")
            (root / "another.mp4").symlink_to(valid)
            self.assertEqual(media_files(root), [valid])
            with self.assertRaises(ValueError):
                media_files(root, max_bytes=3)


class FFmpegTests(unittest.TestCase):
    def test_video_transform_has_fixed_arguments_and_watermark_textfile(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "source.mp4"
            output = root / "out.mp4"
            options = validate_options({
                "crop": [10, 20, 640, 360], "rotate": 90, "height": 480,
                "watermark": "Owner", "compress_crf": 27,
                "trim_start": 1.5, "trim_duration": 4,
            })
            args = ffmpeg_args(source, output, options)
            self.assertEqual(args[0], "ffmpeg")
            self.assertIn("crop=640:360:10:20", " ".join(args))
            self.assertIn("transpose=1", " ".join(args))
            self.assertIn("scale=-2:480", " ".join(args))
            self.assertIn("drawtext=textfile=", " ".join(args))
            self.assertIn("27", args)
            self.assertIn("1.5", args)
            self.assertEqual((root / "owner_watermark.txt").read_text(), "Owner")
            with self.assertRaises(ValueError):
                ffmpeg_args(source, output, {})
            self.assertEqual(ffmpeg_filters({"rotate": 180}), ["hflip", "vflip"])

    def test_explicit_media_codec_and_bitrate_options_are_fixed(self):
        opts = validate_options({"audio_format": "opus", "audio_bitrate": 128})
        args = yt_dlp_args("https://youtube.com/watch?v=test", Path("/tmp"), "audio", options=opts)
        self.assertIn("opus", args)
        self.assertIn("128K", args)
        video = validate_options({"video_codec": "h265", "container": "mkv"})
        converted = ffmpeg_args(Path("source.mp4"), Path("transformed.mkv"), video)
        self.assertIn("libx265", converted)
        self.assertEqual(converted[-1], "transformed.mkv")
        download = yt_dlp_args("https://youtube.com/watch?v=test", Path("/tmp"), "video", options=video)
        self.assertIn("--merge-output-format", download)
        self.assertIn("mkv", download)

    def test_thumbnail_and_metadata_are_bounded(self):
        command = thumbnail_args(Path("a.mp4"), Path("b.jpg"), 5)
        self.assertEqual(command[0], "ffmpeg")
        self.assertIn("-frames:v", command)
        self.assertEqual(ffprobe_args(Path("a.mp4"))[0], "ffprobe")
        screenshot = screenshot_args(Path("a.mp4"), Path("capture.jpg"), 10)
        self.assertIn("min(1280", " ".join(screenshot))
        with self.assertRaises(ValueError):
            thumbnail_args(Path("a.mp4"), Path("b.jpg"), -1)
        with self.assertRaises(ValueError):
            screenshot_args(Path("a.mp4"), Path("capture.jpg"), -1)

        class Result:
            stdout = json.dumps({"format": {"duration": "3.1"},
                                 "streams": [{"codec_name": "h264"}]})

        def fake_exec(command, **kwargs):
            self.assertEqual(command[0], "ffprobe")
            self.assertFalse(kwargs["shell"])
            return Result()

        self.assertEqual(inspect_media(Path("a.mp4"), executor=fake_exec)
                         ["format"]["duration"], "3.1")

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable")
    def test_real_ffmpeg_screenshot_stays_temporary_and_readable(self):
        with tempfile.TemporaryDirectory() as folder:
            video = Path(folder) / "video.mp4"
            screenshot = Path(folder) / "screenshot.jpg"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=blue:s=640x360:d=1",
                            "-c:v", "mpeg4", str(video)],
                           check=True, capture_output=True, timeout=30)
            run_media_command(screenshot_args(video, screenshot, 0), timeout=30)
            self.assertTrue(screenshot.is_file())
            self.assertGreater(screenshot.stat().st_size, 100)


class WorkerIntegrationTests(unittest.TestCase):
    def test_heartbeat_and_progress_reporter_safe_404_fallback(self):
        class Response:
            def __init__(self, status):
                self.status_code = status

        class Client:
            def __init__(self, codes):
                self.codes = iter(codes)
                self.requests = []

            def post(self, url, **kwargs):
                self.requests.append((url, kwargs))
                return Response(next(self.codes))

        headers = {"X-Orbit-Service-Key": "SECRET"}
        client = Client([200, 404])
        heartbeat = MediaHeartbeat(client, "http://127.0.0.1:8787", headers, 12,
                                   interval=0)
        self.assertTrue(heartbeat.tick())
        self.assertFalse(heartbeat.tick())
        with heartbeat:
            self.assertIsNone(heartbeat.thread)
        self.assertEqual(client.requests[0][1]["json"], {"id": 12})
        self.assertEqual(client.requests[0][1]["headers"], headers)

        client = Client([200, 404])
        progress = MediaProgressReporter(client, "https://control.example", headers,
                                         12, interval=5)
        progress({"stage": "download", "bytes": 1, "total": 8,
                  "eta_seconds": 3, "source_url": "private"})
        progress({"stage": "download", "bytes": 2, "total": 8})
        self.assertEqual(len(client.requests), 1)  # Throttled.
        sent = client.requests[0][1]["json"]
        self.assertNotIn("source_url", sent)
        self.assertEqual(sent["id"], 12)
        progress({"stage": "uploaded_file", "done": 1, "total": 1})
        self.assertTrue(progress.disabled)
        progress({"stage": "uploaded_file", "done": 1, "total": 1})
        self.assertEqual(len(client.requests), 2)  # 404 disables permanently.

    def test_social_sources_are_opt_in_only(self):
        self.assertNotIn("instagram.com", DEFAULT_HOSTS)
        self.assertIn("instagram.com", SOCIAL_HOSTS)
        args = yt_dlp_args("https://youtube.com/playlist?list=x",
                           Path("/tmp/test"), "video",
                           options={"playlist_limit": 3, "subtitles": True,
                                    "embed_metadata": True, "max_bytes": 5_000_000})
        self.assertIn("--yes-playlist", args)
        self.assertIn("--playlist-end", args)
        self.assertIn("--write-subs", args)
        self.assertIn("--embed-metadata", args)
        self.assertIn("--ignore-config", args)
        self.assertIn("%(title).80s", args[args.index("-o") + 1])
        self.assertEqual(args[-2], "--")
        progress_args = yt_dlp_args("https://youtube.com/x", Path("/tmp/test"),
                                    "video", progress=True)
        self.assertIn("--progress-template", progress_args)
        with self.assertRaises(ValueError):
            yt_dlp_args("https://youtube.com", Path("/tmp/test"),
                        "audio", options={"crop": "bad"})

    def test_bot_api_endpoints_restrict_to_official_and_loopback(self):
        self.assertEqual(validate_bot_api_base("https://api.telegram.org/"),
                         "https://api.telegram.org")
        with self.assertRaises(ValueError):
            validate_bot_api_base("http://localhost:8081")
        self.assertEqual(validate_bot_api_base("http://localhost:8081", True),
                         "http://127.0.0.1:8081")
        for bad in ["https://notapi.telegram.org",
                    "https://api.telegram.org.evil.com",
                    "https://api.telegram.org/botTOKEN", "http://localhost:8080",
                    "http://127.0.0.2:8081", "https://api.telegram.org?token=x"]:
            with self.subTest(url=bad), self.assertRaises(ValueError):
                validate_bot_api_base(bad, True)

    def test_job_process_batch_caption_filename_topic_and_ephemeral_files(self):
        sent = []
        temporary_paths = []
        updates = []

        class Response:
            status_code = 200

            def __init__(self, message_id):
                self.message_id = message_id

            def json(self):
                return {"ok": True, "result": {"message_id": self.message_id}}

        class Client:
            def post(self, endpoint, data=None, files=None, timeout=None):
                self_test.assertIn("/sendDocument", endpoint)
                payload = files["document"]
                temporary_paths.append(Path(payload[1].stream.name))
                sent.append((payload[0], payload[1].read(), dict(data)))
                return Response(len(sent))

        def fake_execute(command, **kwargs):
            self.assertEqual(command[0], "yt-dlp")
            output_pattern = command[command.index("-o") + 1]
            Path(output_pattern.replace("%(ext)s", "mp4")).write_bytes(b"video")

        self_test = self
        client = Client()
        job = {"kind": "video",
               "urls": ["https://youtube.com/one", "https://youtube.com/two"],
               "dest": -1234, "dest_topic": 42, "options": {
                    "caption": "Old link", "replacements": [["Old", "New"]],
                    "filename": "Personal sample",
               }}
        with patch("worker.validate_url", side_effect=lambda url, hosts: url), \
             patch("worker.shutil.which", return_value="/usr/bin/yt-dlp"), \
             patch("worker.run_download_command", side_effect=lambda args, callback: fake_execute(args)), \
             patch("worker.time.sleep"):
            receipt = process(job, client, "DUMMY_BOT_TOKEN",
                              DEFAULT_HOSTS, progress=updates.append)
        self.assertEqual(receipt["uploaded"], 2)
        self.assertEqual(len(sent), 2)
        self.assertTrue(all(name == "Personal sample.mp4" for name, _, _ in sent))
        self.assertTrue(all(payload == b"video" for _, payload, _ in sent))
        self.assertTrue(all(data["caption"] == "New link" and
                            data["message_thread_id"] == "42"
                            for _, _, data in sent))
        self.assertTrue(any(update["stage"] == "upload" for update in updates))
        self.assertTrue(all(not path.exists() for path in temporary_paths))

    def test_subtitles_upload_and_partial_delivery_cannot_retry_blindly(self):
        def fake_download(args, **kwargs):
            output_pattern = args[args.index("-o") + 1]
            Path(output_pattern.replace("%(ext)s", "mp4")).write_bytes(b"video")
            Path(output_pattern.replace("%(ext)s", "en.srt")).write_bytes(b"subtitle text")

        class Response:
            def __init__(self, good=True):
                self.good = good

            def json(self):
                return {"ok": self.good,
                        "result": {"message_id": 50} if self.good else {},
                        "error_code": 400 if not self.good else None}

        class Client:
            def __init__(self, fail_second=False):
                self.sent = []
                self.fail_second = fail_second

            def post(self, url, data, files, timeout):
                self.sent.append((files["document"][0], files["document"][1].read()))
                return Response(not self.fail_second or len(self.sent) == 1)

        job = {"url": "https://youtube.com/watch?v=x", "kind": "video",
               "dest": 1, "options": {"subtitles": True}}
        with patch("worker.validate_url", side_effect=lambda url, hosts: url), \
             patch("worker.shutil.which", return_value="/usr/bin/yt-dlp"), \
             patch("worker.run_media_command", side_effect=fake_download), \
             patch("worker.time.sleep"):
            client = Client()
            receipt = process(job, client, "BOT", DEFAULT_HOSTS)
            self.assertEqual(receipt["uploaded"], 2)
            self.assertEqual(receipt["subtitles_uploaded"], 1)
            self.assertEqual(client.sent[1][1], b"subtitle text")

            with self.assertRaises(PartialDeliveryError):
                process(job, Client(fail_second=True), "BOT", DEFAULT_HOSTS)

    def test_batch_validation_and_large_file_guards(self):
        class NeverCalled:
            def post(self, *args, **kwargs):
                raise AssertionError("Network access must not occur")

        with patch("worker.validate_url", side_effect=lambda url, hosts: url):
            for job in [
                {"kind": "video", "urls": [], "dest": 1},
                {"kind": "video", "urls": ["https://youtube.com/x"] * 11,
                 "dest": 1},
                {"kind": "video", "url": "https://youtube.com/x",
                 "options": {"max_bytes": 200_000_000}, "dest": 1},
                {"kind": "video", "url": "https://youtube.com/x",
                 "options": {"max_bytes": 600_000_000, "split": True},
                 "dest": 1},
            ]:
                with self.subTest(job=job), self.assertRaises(ValueError):
                    process(job, NeverCalled(), "TOKEN", DEFAULT_HOSTS)


if __name__ == "__main__":
    unittest.main()
