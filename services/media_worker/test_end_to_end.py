"""Exercise media conversion and ephemeral upload orchestration without Internet.

Only yt-dlp extraction and Telegram's remote API are substituted. FFmpeg really
generates the MP3 fixture, and multipart bytes pass through an HTTPX transport.
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import worker


class MediaEndToEndTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for local media integration")
    def test_audio_extract_to_telegram_upload_and_cleanup(self):
        try:
            import httpx
        except ImportError:
            self.skipTest("HTTPX unavailable")
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "tone.wav"
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                            "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", str(source)],
                           capture_output=True, check=True, timeout=30)
            original_which = shutil.which
            downloaded_paths = []
            sent_payloads = []

            def fake_which(name):
                return "/usr/bin/true" if name == "yt-dlp" else original_which(name)

            def download(command, timeout=1800):
                self.assertEqual(command[0], "yt-dlp")
                self.assertIn("--audio-format", command)
                self.assertIn("mp3", command)
                output = Path(command[command.index("-o") + 1]).parent / "tone.mp3"
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i",
                                str(source), "-c:a", "libmp3lame", str(output)],
                               capture_output=True, check=True, timeout=30)
                downloaded_paths.append(output)

            def respond(request):
                self.assertIn("/sendDocument", str(request.url))
                body = request.read()
                self.assertIn(b'tone.mp3', body)
                self.assertIn(b'Content-Type: application/octet-stream', body)
                self.assertGreater(len(body), 1000)
                sent_payloads.append(body)
                return httpx.Response(200, json={"ok": True, "result": {"message_id": 710}})

            with httpx.Client(transport=httpx.MockTransport(respond)) as client, \
                 patch("worker.shutil.which", side_effect=fake_which), \
                 patch("worker.run_media_command", side_effect=download), \
                 patch("worker.time.sleep"), \
                 patch("worker.socket.getaddrinfo", return_value=[
                     (2, 1, 6, "", ("8.8.8.8", 443))]):
                result = worker.process({"url": "https://youtube.com/watch?v=own-test",
                    "kind": "audio", "dest": "-1001234567890", "dest_topic": 55},
                    client, "FAKE_TOKEN", ("youtube.com",))
            self.assertEqual(result["uploaded"], 1)
            self.assertEqual(result["files"][0]["message_id"], 710)
            self.assertEqual(len(sent_payloads), 1)
            self.assertTrue(downloaded_paths)
            self.assertTrue(all(not path.exists() for path in downloaded_paths))

    def test_explicit_source_allowlist_blocks_unapproved_and_local_domains(self):
        with patch("worker.socket.getaddrinfo", return_value=[
                (2, 1, 6, "", ("8.8.8.8", 443))]):
            with self.assertRaises(ValueError):
                worker.validate_url("https://unapproved.example/video", ("youtube.com",))
            with self.assertRaises(ValueError):
                worker.validate_url("https://youtube.com.evil.example/video", ("youtube.com",))
        with patch("worker.socket.getaddrinfo", return_value=[
                (2, 1, 6, "", ("10.0.0.7", 443))]):
            with self.assertRaises(ValueError):
                worker.validate_url("https://youtube.com/watch?v=x", ("youtube.com",))


if __name__ == "__main__":
    unittest.main()
