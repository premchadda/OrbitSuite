import unittest
import contextlib
import io
from types import SimpleNamespace
from history import parse_args, eligible_message


class HistoryTests(unittest.TestCase):
    def test_dry_run_default_and_batch_cap(self):
        args = parse_args(["--source", "-100123456", "--dest", "me", "--first", "2", "--last", "5"])
        self.assertFalse(args.execute)
        self.assertEqual(args.delay, 5.0)
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args(["--source", "A", "--dest", "me", "--first", "1", "--last", "501"])

    def test_rejects_protected_and_wrong_topic(self):
        self.assertFalse(eligible_message(SimpleNamespace(empty=False,
            has_protected_content=True, message_thread_id=12), 12))
        self.assertFalse(eligible_message(SimpleNamespace(empty=False,
            has_protected_content=False, message_thread_id=11), 12))
        self.assertTrue(eligible_message(SimpleNamespace(empty=False,
            has_protected_content=False, message_thread_id=12), 12))


if __name__ == "__main__":
    unittest.main()
