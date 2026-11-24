import contextlib
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest

from catalog import clean_record, export_catalog, import_catalog, load_report, main, timeline
from state import Report, metadata_record
from test_state import entry


class CatalogTests(unittest.TestCase):
    def test_export_import_and_daily_topic_timeline_without_message_text(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            report_path, catalog_path, imported_path = [root / name for name in
                ("events.jsonl", "portable.json", "imported.jsonl")]
            message = entry()
            message.date = datetime(2026, 11, 24, 15, 30, tzinfo=timezone.utc)
            first = metadata_record(message, "-100123", 1, include_filename=True)
            first["caption"] = "never export this private content"
            reporter = Report(report_path)
            try:
                reporter.write("would_copy", first)
                reporter.write("skipped", {"message_id": 2, "reason": "protected"})
                reporter.write("copied", {**first, "message_id": 3, "media_kind": "video"})
            finally:
                reporter.close()

            self.assertEqual(export_catalog(report_path, catalog_path), 2)
            text = catalog_path.read_text()
            self.assertNotIn("never export", text)
            self.assertNotIn("caption", text)
            self.assertEqual(import_catalog(catalog_path, imported_path), 2)
            self.assertEqual(load_report(imported_path), load_report(report_path))
            days = timeline(imported_path, "2026-11")
            self.assertEqual(len(days), 1)
            self.assertEqual(days[0]["count"], 2)
            self.assertEqual(days[0]["topic"], 5)
            self.assertEqual(days[0]["media"], {"document": 1, "video": 1})
            self.assertEqual(timeline(imported_path, "2026-10"), [])
            with self.assertRaises(FileExistsError):
                export_catalog(report_path, catalog_path)

    def test_invalid_and_unsafe_metadata_rejected_before_import(self):
        with self.assertRaisesRegex(ValueError, "Invalid source"):
            clean_record({"source": "", "message_id": 1, "media_kind": "text"})
        with self.assertRaisesRegex(ValueError, "Invalid date"):
            clean_record({"source": "A", "message_id": 1, "media_kind": "text", "date": "yesterday"})
        with tempfile.TemporaryDirectory() as folder:
            path, target = Path(folder) / "catalog.json", Path(folder) / "events.jsonl"
            path.write_text(json.dumps({"schema": "orbit-history-catalog", "version": 1,
                                        "records": [{"source": "", "message_id": 1, "media_kind": "text"}]}))
            with self.assertRaises(ValueError):
                import_catalog(path, target)
            self.assertFalse(target.exists())

    def test_timeline_cli_runs_offline_and_unknown_dates_are_grouped(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "legacy.jsonl"
            reporter = Report(path)
            reporter.write("copied", {"source": "A", "message_id": 1,
                                      "media_kind": "text", "topic": None})
            reporter.close()
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                main(["timeline", "--report", str(path)])
            self.assertIn('"day": "unknown"', output.getvalue())


if __name__ == "__main__":
    unittest.main()
