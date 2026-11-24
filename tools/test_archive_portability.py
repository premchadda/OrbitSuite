import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

from tools.archive_portability import export_bundle, import_bundle, main, validate_bundle


MIGRATIONS = Path(__file__).resolve().parents[1] / "apps/worker/migrations"
SOURCE = "-1001234567890"
DEST = "-1009876543210"


def database(path=":memory:"):
    db = sqlite3.connect(path)
    for file in sorted(MIGRATIONS.glob("[0-9]*.sql")):
        db.executescript(file.read_text(encoding="utf8"))
    return db


def populated(db):
    db.execute("INSERT INTO routes(source,topic,dest,dest_topic,kind,mode,sender_id) "
               "VALUES(?,?,?,?,?,?,?)", (SOURCE, 7, DEST, 9, "pdf", "copy", "12345"))
    db.execute("INSERT INTO archive_items(source,source_message_id,dest,dest_topic,"
               "dest_message_id,media_kind,filename,caption_preview,saved_at) "
               "VALUES(?,?,?,?,?,?,?,?,?)", (SOURCE, 77, DEST, 9, 88, "pdf",
                                         "SSC_CGL.pdf", "Math notes", 1_700_000_000))
    db.commit()


class PortabilityTests(unittest.TestCase):
    def test_preview_and_confirmed_import_disable_routes_and_dedupe(self):
        with database() as origin, database() as target:
            populated(origin)
            bundle = export_bundle(origin)
            self.assertEqual(bundle["version"], 1)
            self.assertNotIn("BOT_TOKEN", json.dumps(bundle))
            self.assertEqual(import_bundle(target, bundle)["dry_run"], True)
            self.assertEqual(target.execute("SELECT count(*) FROM routes").fetchone()[0], 0)
            first = import_bundle(target, bundle, confirmed=True)
            self.assertEqual(first["imported"], {"routes": 1, "archive_items": 1})
            route = target.execute("SELECT enabled,auto_topics,sender_id FROM routes").fetchone()
            self.assertEqual(route, (0, 0, "12345"))
            self.assertEqual(import_bundle(target, bundle, confirmed=True)["imported"],
                             {"routes": 0, "archive_items": 0})

    def test_malformed_records_and_cycle_refused_without_writes(self):
        with database() as origin, database() as target:
            populated(origin)
            bundle = export_bundle(origin)
            forged = json.loads(json.dumps(bundle))
            forged["routes"][0]["kind"] = "invalid; DROP TABLE routes;"
            with self.assertRaises(ValueError):
                validate_bundle(forged)
            forged = json.loads(json.dumps(bundle))
            forged["archive_items"][0]["caption_preview"] = "x" * 5000
            with self.assertRaises(ValueError):
                validate_bundle(forged)
            target.execute("INSERT INTO routes(source,topic,dest,dest_topic,kind,mode) "
                           "VALUES(?,?,?,?,?,?)", (DEST, 0, SOURCE, 0, "all", "copy"))
            target.commit()
            with self.assertRaisesRegex(ValueError, "cycle"):
                import_bundle(target, bundle, confirmed=True)
            self.assertEqual(target.execute("SELECT count(*) FROM routes").fetchone()[0], 1)
            self.assertEqual(target.execute("SELECT count(*) FROM archive_items").fetchone()[0], 0)

    def test_cli_exports_private_file_never_overwrites_and_requires_confirm(self):
        with tempfile.TemporaryDirectory() as temp:
            db_path = Path(temp) / "personal.sqlite"
            export = Path(temp) / "backup.json"
            db = database(db_path)
            populated(db)
            db.close()
            self.assertEqual(main(["--db", str(db_path), "export", str(export)]), 0)
            self.assertEqual(os.stat(export).st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                main(["--db", str(db_path), "export", str(export)])
            self.assertEqual(main(["--db", str(db_path), "preview", str(export)]), 0)
            with self.assertRaises(SystemExit):
                main(["--db", str(db_path), "import", str(export)])


if __name__ == "__main__":
    unittest.main()
