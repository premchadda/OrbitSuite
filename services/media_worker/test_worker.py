import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from worker import allowed_host, choose_file, validate_url, validate_control_url, yt_dlp_args, MAX_BYTES


class MediaTests(unittest.TestCase):
    def test_host_allowlist_uses_label_boundaries(self):
        self.assertTrue(allowed_host("music.youtube.com", ("youtube.com",)))
        self.assertFalse(allowed_host("notyoutube.com", ("youtube.com",)))

    def test_private_resolution_is_rejected(self):
        with patch("worker.socket.getaddrinfo", return_value=[
            (2, 1, 6, "", ("127.0.0.1", 443))
        ]):
            with self.assertRaises(ValueError):
                validate_url("https://youtube.com/watch?v=test")

    def test_https_url_and_public_resolution(self):
        with patch("worker.socket.getaddrinfo", return_value=[
            (2, 1, 6, "", ("8.8.8.8", 443))
        ]):
            self.assertEqual(validate_url("https://youtube.com/watch?v=test"),
                             "https://youtube.com/watch?v=test")
        with self.assertRaises(ValueError):
            validate_url("http://youtube.com/watch?v=test")

    def test_extractor_uses_no_shell_and_single_video(self):
        args = yt_dlp_args("https://youtube.com/watch?v=x", Path("/tmp/test"), "video")
        self.assertIn("--no-playlist", args)
        self.assertEqual(args[-2], "--")
        self.assertEqual(args[-1], "https://youtube.com/watch?v=x")
        limited = yt_dlp_args("https://youtube.com/watch?v=x", Path("/tmp/test"), "video", "480")
        self.assertIn("best[height<=480]", limited)
        audio = yt_dlp_args("https://youtube.com/watch?v=x", Path("/tmp/test"), "audio", "2")
        self.assertIn("2", audio)
        with self.assertRaises(ValueError):
            yt_dlp_args("https://youtube.com/watch?v=x", Path("/tmp/test"), "video", "9999")

    def test_file_size_guard(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "test.bin"
            path.write_bytes(b"abc")
            self.assertEqual(choose_file(Path(folder)), path)
            with path.open("r+b") as handle:
                handle.truncate(MAX_BYTES + 1)
            with self.assertRaises(ValueError):
                choose_file(Path(folder))

    def test_private_control_plane_requires_explicit_loopback_opt_in(self):
        self.assertEqual(validate_control_url("https://example.com/api"),
                         "https://example.com/api")
        with self.assertRaises(ValueError):
            validate_control_url("http://127.0.0.1:8787")
        self.assertEqual(validate_control_url("http://127.0.0.1:8787", True),
                         "http://127.0.0.1:8787")
        for url in ("http://evil.example:8787", "http://127.0.0.1:8000",
                    "http://user:pass@localhost:8787", "http://localhost:8787/a"):
            with self.assertRaises(ValueError):
                validate_control_url(url, True)


if __name__ == "__main__":
    unittest.main()
