import hashlib
import unittest

from telegram_parts import check_parts, join_telegram_parts, safe_telegram_path
from worker import process


def parts():
    return [
        {"file_id": "A" * 20, "filename": "study.pdf.part001", "file_size": 6},
        {"file_id": "B" * 20, "filename": "study.pdf.part002", "file_size": 5},
    ]


class MockReply:
    def __init__(self, data=None, chunks=None):
        self.data = data or {}
        self.chunks = chunks or []

    def json(self):
        return self.data

    def raise_for_status(self):
        return None

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def iter_bytes(self, chunk_size=None):
        yield from self.chunks


class MockTelegram:
    def __init__(self):
        self.sent = []

    def post(self, url, **kw):
        if url.endswith("/getFile"):
            letter = kw["json"]["file_id"][0]
            return MockReply({"ok": True, "result": {
                "file_path": "documents/" + letter + ".bin",
                "file_size": 6 if letter == "A" else 5,
            }})
        if url.endswith("/sendDocument"):
            uploaded = kw["files"]["document"][1].read()
            self.sent.append((kw["files"]["document"][0], uploaded, kw["data"]))
            return MockReply({"ok": True, "result": {"message_id": 400}})
        raise AssertionError("Unexpected endpoint")

    def stream(self, method, url, **kw):
        if method != "GET":
            raise AssertionError("Unexpected method")
        return MockReply(chunks=[b"hello " if url.endswith("A.bin") else b"world"])


class JoinTests(unittest.TestCase):
    def test_checks_reject_bad_file_paths_order_sizes_and_public_limits(self):
        self.assertEqual(len(check_parts(parts(), local_api=False)), 2)
        for raw in ["/etc/passwd", "../secrets/file", "documents//x", "documents/x?token=1"]:
            with self.assertRaises(ValueError):
                safe_telegram_path(raw)
        with self.assertRaises(ValueError):
            check_parts(list(reversed(parts())), local_api=False)
        forged = parts()
        forged[0]["file_size"] = 21 * 1024 * 1024
        with self.assertRaises(ValueError):
            check_parts(forged, local_api=False)
        forged[0]["filename"] = "../secret.part001"
        with self.assertRaises(ValueError):
            check_parts(forged, local_api=True)

    def test_real_join_is_ephemeral_and_uploads_once_with_sha256(self):
        client = MockTelegram()
        job = {"parts": parts(), "kind": "video", "dest": "12345", "dest_topic": 0}
        result = process(job, client, "TEST_BOT_TOKEN", (), api_base="https://api.telegram.org")
        self.assertEqual(result["uploaded"], 1)
        self.assertEqual(client.sent[0][0], "study.pdf")
        self.assertEqual(client.sent[0][1], b"hello world")
        self.assertEqual(result["files"][0]["sha256"], hashlib.sha256(b"hello world").hexdigest())
        self.assertEqual(client.sent[0][2]["chat_id"], "12345")


if __name__ == "__main__":
    unittest.main()
