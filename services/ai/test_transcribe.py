"""Offline tests for local-only STT subprocess adapter."""

from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from services.ai.transcribe import transcribe_local_media, TranscriptionUnavailable


class LocalTranscriptionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        (base / "media").mkdir()
        (base / "models").mkdir()
        self.media = base / "media" / "lecture.wav"
        self.media.write_bytes(b"RIFF offline fixture")
        self.model = base / "models" / "tiny.bin"
        self.model.write_bytes(b"offline fixture model")

    def run_transcription(self, **changes):
        kwargs = {"media_root": self.media.parent, "model_root": self.model.parent,
                  "model_path": self.model}
        kwargs.update(changes)
        return transcribe_local_media(self.media, **kwargs)

    @patch("services.ai.transcribe.shutil.which", return_value=None)
    def test_missing_local_binary_is_explicit(self, _which):
        with self.assertRaises(TranscriptionUnavailable):
            self.run_transcription()

    @patch("services.ai.transcribe.shutil.which", return_value="/usr/bin/whisper-cli")
    @patch("services.ai.transcribe.subprocess.run")
    def test_command_uses_fixed_arguments_without_shell_and_reads_output(self, run, _which):
        def fake(cmd, **opts):
            self.assertNotIn("shell", opts)
            self.assertEqual(cmd[1], "-m")
            self.assertIn(str(self.media), cmd)
            Path(cmd[cmd.index("-of") + 1] + ".txt").write_text("Hello world")
        run.side_effect = fake
        self.assertEqual(self.run_transcription(), "Hello world")

    def test_unapproved_path_and_unexpected_executable_refused(self):
        with self.assertRaises(ValueError):
            self.run_transcription(executable="sh")
        outside = Path(self.temp.name) / "outside.wav"
        outside.write_bytes(b"private")
        with self.assertRaises(ValueError):
            transcribe_local_media(outside, media_root=self.media.parent,
                                   model_root=self.model.parent, model_path=self.model)
        with self.assertRaises(ValueError):
            self.run_transcription(timeout=1800)


if __name__ == "__main__":
    unittest.main()
