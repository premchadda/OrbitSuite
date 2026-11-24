import asyncio
import contextlib
import io
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from history import parse_args, copy_range, identity_for
from state import Checkpoint, Report, file_identity, metadata_record


class FakeClient:
    def __init__(self, messages, fail_on=None):
        self.messages = messages
        self.fail_on = fail_on
        self.read = []
        self.sent = []

    async def get_messages(self, source, message_id):
        self.read.append(message_id)
        return self.messages.get(message_id)

    async def copy_message(self, *, chat_id, from_chat_id, message_id):
        if message_id == self.fail_on:
            raise TimeoutError("unknown result")
        self.sent.append((from_chat_id, chat_id, message_id))


def entry(uid="AAA", topic=5):
    return SimpleNamespace(empty=False, has_protected_content=False,
        chat=SimpleNamespace(has_protected_content=False),
        message_thread_id=topic, document=SimpleNamespace(file_unique_id=uid,
            file_name="lesson.pdf"))


class StateTests(unittest.TestCase):
    def test_checkpoint_prevents_implicit_ambiguous_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "checkpoint.json"
            args = parse_args(["--source", "-100123456", "--dest", "me", "--first", "1",
                "--last", "2", "--execute", "--checkpoint", str(path)])
            cp = Checkpoint(path, identity_for(args))
            cp.start(1)
            cp.mark_inflight(1)
            with self.assertRaisesRegex(ValueError, "Uncertain in-flight"):
                Checkpoint(path, identity_for(args)).start(1, resume=True)
            with self.assertRaisesRegex(ValueError, "differs"):
                Checkpoint(path, {**identity_for(args), "dest": "elsewhere"}).start(1, resume=True)
            resumed = Checkpoint(path, identity_for(args))
            self.assertEqual(resumed.start(1, resume=True, skip_uncertain=True).next_id, 2)
            self.assertEqual(resumed.state.counters["uncertain_skipped"], 1)
            self.assertIsNone(resumed.state.inflight)

    def test_checkpoint_process_lock_refuses_concurrent_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "checkpoint.json"
            first = Checkpoint(path, {"source": "A"})
            with first.exclusive():
                self.assertTrue(path.with_name("checkpoint.json.lock").exists())
                with self.assertRaisesRegex(ValueError, "in use"):
                    with Checkpoint(path, {"source": "A"}).exclusive():
                        pass
            self.assertFalse(path.with_name("checkpoint.json.lock").exists())

    def test_preview_reports_skips_and_deduplicates_file_unique_id(self):
        with tempfile.TemporaryDirectory() as folder:
            cp_path = Path(folder) / "checkpoint.json"
            report_path = Path(folder) / "report.jsonl"
            args = parse_args(["--source", "-100123456", "--dest", "me", "--first", "1",
                "--last", "3", "--checkpoint", str(cp_path), "--report", str(report_path),
                "--topic", "5", "--dedup-file-ids", "--include-filename"])
            cp = Checkpoint(cp_path, identity_for(args))
            cp.start(1)
            report = Report(report_path)
            client = FakeClient({1: entry("same"), 2: entry("same"), 3: entry("unique", topic=6)})
            result = asyncio.run(copy_range(args, client, cp, report))
            report.close()
            self.assertEqual(result["previewed"], 1)
            self.assertEqual(result["skipped"], 2)
            self.assertEqual(result["next_id"], 4)
            self.assertEqual(client.sent, [])
            lines = report_path.read_text().splitlines()
            self.assertEqual(len(lines), 3)
            self.assertIn('"event": "would_copy"', lines[0])
            self.assertIn('"filename": "lesson.pdf"', lines[0])
            self.assertIn('"reason": "duplicate_file"', lines[1])
            self.assertIn('"reason": "wrong_topic"', lines[2])

    def test_execute_unknown_copy_retains_inflight_and_does_not_retry(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "checkpoint.json"
            args = parse_args(["--source", "-100123456", "--dest", "me", "--first", "2",
                "--last", "2", "--execute", "--checkpoint", str(path)])
            cp = Checkpoint(path, identity_for(args))
            cp.start(2)
            result = asyncio.run(copy_range(args, FakeClient({2: entry()}, fail_on=2), cp))
            self.assertEqual(result["failure"], "uncertain_send")
            self.assertEqual(Checkpoint(path, identity_for(args)).load().inflight, 2)
            with self.assertRaises(ValueError):
                Checkpoint(path, identity_for(args)).start(2, resume=True)
            retry = Checkpoint(path, identity_for(args))
            retry.start(2, resume=True, retry_uncertain=True)
            result = asyncio.run(copy_range(args, FakeClient({2: entry()}), retry))
            self.assertEqual(result["copied"], 1)
            self.assertIsNone(retry.state.inflight)

    def test_file_hash_metadata_remains_bounded_without_credentials(self):
        record = metadata_record(entry(), "-100123456", 12, include_filename=True)
        self.assertEqual(record["filename"], "lesson.pdf")
        digest = file_identity(entry("sensitive-real-id"))
        self.assertEqual(len(digest), 64)
        self.assertNotIn("sensitive", digest)
        self.assertEqual(digest, file_identity(entry("sensitive-real-id")))
        photo = SimpleNamespace(photo=SimpleNamespace(file_unique_id="PHOTO-ID"))
        self.assertEqual(len(file_identity(photo)), 64)

    def test_cli_requires_explicit_reconciliation_and_safe_schedule(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args(["--source", "A", "--dest", "me", "--first", "1",
                            "--last", "2", "--execute"])
            with self.assertRaises(SystemExit):
                parse_args(["--source", "A", "--dest", "me", "--first", "1",
                            "--last", "2", "--scheduled-at", "2027-01-01T12:00:00"])
            with self.assertRaises(SystemExit):
                parse_args(["--logout", "YES"])
        self.assertEqual(parse_args(["--logout", "CONFIRM"]).logout, "CONFIRM")


if __name__ == "__main__":
    unittest.main()
