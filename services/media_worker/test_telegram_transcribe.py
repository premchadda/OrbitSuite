from pathlib import Path
from unittest import TestCase, mock

from telegram_transcribe import transcribe_telegram_audio


class Reply:
    def __init__(self, data=None, data_bytes=b"raw!"):
        self.data = data or {}
        self.data_bytes = data_bytes

    def json(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return None

    def raise_for_status(self):
        return None

    def iter_bytes(self, chunk_size=None):
        yield self.data_bytes


class FakeClient:
    def __init__(self):
        self.requests = []

    def post(self, url, **kwargs):
        self.requests.append((url, kwargs))
        if url.endswith("/getFile"):
            return Reply({"ok": True, "result": {"file_path": "voice/sample.oga", "file_size": 4}})
        if url.endswith("/sendMessage"):
            return Reply({"ok": True, "result": {"message_id": 700}})
        raise AssertionError("Unexpected Bot API action")

    def stream(self, method, url, **kwargs):
        self.requests.append((url, kwargs))
        return Reply()


class TranscriptionTests(TestCase):
    def test_owner_audio_transcribes_with_fixed_ffmpeg_and_private_result(self):
        client = FakeClient()
        job = {"task": "transcribe", "file_id": "VOICEFILEIDENTIFIER123456", "dest": "12345"}
        def fake_ffmpeg(args, **kwargs):
            self.assertEqual(args[0], "ffmpeg")
            self.assertIn("pcm_s16le", args)
            Path(args[-1]).write_bytes(b"WAVE")
        def fake_transcriber(media_path, **kwargs):
            self.assertEqual(Path(media_path).suffix, ".wav")
            self.assertTrue(Path(media_path).is_file())
            self.assertEqual(kwargs["model_root"], "/models")
            return "Speech for local test"
        with mock.patch("telegram_transcribe.subprocess.run", side_effect=fake_ffmpeg):
            result = transcribe_telegram_audio(job, client, "TOKEN",
                "https://api.telegram.org", model_root="/models",
                model_name="tiny.bin", transcriber=fake_transcriber)
        self.assertEqual(result["uploaded"], 1)
        self.assertEqual(result["files"][0]["message_id"], 700)
        sent = client.requests[-1]
        self.assertTrue(sent[0].endswith("/sendMessage"))
        self.assertEqual(sent[1]["json"]["chat_id"], "12345")
        self.assertIn("Speech for local test", sent[1]["json"]["text"])

    def test_invalid_file_id_or_model_is_refused_before_network(self):
        client = FakeClient()
        for job, model in [({"task": "transcribe", "file_id": "!bad", "dest": "12345"}, "tiny.bin"),
                           ({"task": "transcribe", "file_id": "A"*20, "dest": "12345"}, "../bad.bin")]:
            with self.assertRaises(ValueError):
                transcribe_telegram_audio(job, client, "TOKEN", "https://api.telegram.org",
                    model_root="/models", model_name=model)
        self.assertEqual(client.requests, [])
