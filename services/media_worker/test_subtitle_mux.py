import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from media_features import embed_subtitles_args, validate_options
from worker import yt_dlp_args


class SubtitleMuxTests(unittest.TestCase):
    def test_flag_requires_boolean_and_requests_caption_sidecar_from_extractor(self):
        self.assertEqual(validate_options({"embed_subtitles": True})["embed_subtitles"], True)
        with self.assertRaises(ValueError):
            validate_options({"embed_subtitles": "yes"})
        with tempfile.TemporaryDirectory() as temp:
            args = yt_dlp_args("https://example.com/clip", Path(temp), "video",
                               options={"embed_subtitles": True})
            self.assertIn("--write-subs", args)
            self.assertIn("en", args)
            source = Path(temp) / "a.mp4"
            subtitle = Path(temp) / "sub.srt"
            output = Path(temp) / "new.mp4"
            command = embed_subtitles_args(source, subtitle, output)
            self.assertEqual(command[0], "ffmpeg")
            self.assertIn("mov_text", command)
            with self.assertRaises(ValueError):
                embed_subtitles_args(source, subtitle, source)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"),
                         "FFmpeg not installed")
    def test_real_ffmpeg_muxes_english_subtitle_stream(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "synthetic.mp4"
            subtitle = root / "english.srt"
            output = root / "subtitled.mp4"
            subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                            "-f", "lavfi", "-i", "color=c=black:s=64x64:r=1",
                            "-t", "2", "-c:v", "mpeg4", str(source)],
                           check=True, timeout=30)
            subtitle.write_text("1\n00:00:00,000 --> 00:00:01,000\nOriginal text\n", encoding="utf8")
            subprocess.run(embed_subtitles_args(source, subtitle, output),
                           check=True, timeout=30)
            result = subprocess.run(["ffprobe", "-v", "error", "-show_streams",
                                     "-of", "json", str(output)],
                                    capture_output=True, text=True, check=True, timeout=30)
            streams = json.loads(result.stdout)["streams"]
            self.assertTrue(any(s.get("codec_type") == "subtitle"
                                and s.get("codec_name") == "mov_text" for s in streams))


if __name__ == "__main__":
    unittest.main()
