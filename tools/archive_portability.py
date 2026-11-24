"""Portable, metadata-only OrbitSuite route/archive backup for SQLite hosts.

No Telegram tokens, user sessions, downloaded media, or message text bodies.
Imported routes always begin disabled. Live queues are never imported.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sqlite3
import sys

VERSION = 1
MAX_IMPORT_BYTES = 16 * 1024 * 1024
MAX_ITEMS = 100_000
MAX_ROUTES = 100
ROUTE_FIELDS = (
    "source", "topic", "dest", "dest_topic", "kind", "mode",
    "include_text", "exclude_text", "caption_template", "sender_id",
    "min_bytes", "max_bytes", "auto_topics", "sync_topic_titles",
    "propagate_edits", "regex_include", "regex_exclude", "mime_csv",
    "extension_csv", "date_from", "date_to", "window_utc", "weekdays_csv",
)
ITEM_FIELDS = (
    "source", "source_message_id", "dest", "dest_topic", "dest_message_id",
    "media_kind", "filename", "caption_preview", "saved_at",
)
VALID_KINDS = {"all", "pdf", "document", "video", "photo", "audio", "voice", "animation", "sticker"}
VALID_MODES = {"copy", "forward"}
CHAT = re.compile(r"^-100\d{5,16}$")


def _dicts(connection: sqlite3.Connection, table: str, fields: tuple[str, ...]):
    column_names = {column[1] for column in connection.execute("PRAGMA table_info(" + table + ")")}
    if not set(fields).issubset(column_names):
        raise ValueError("Database is missing required current OrbitSuite migrations")
    return [dict(zip(fields, row)) for row in connection.execute(
        "SELECT " + ",".join(fields) + " FROM " + table + " ORDER BY id")]


def export_bundle(connection: sqlite3.Connection) -> dict:
    routes = _dicts(connection, "routes", ROUTE_FIELDS)
    items = _dicts(connection, "archive_items", ITEM_FIELDS)
    if len(routes) > MAX_ROUTES or len(items) > MAX_ITEMS:
        raise ValueError("Archive exceeds the bounded portable format")
    return {"schema": "orbitsuite-metadata", "version": VERSION,
            "routes": routes, "archive_items": items}


def _valid_chat(value):
    return isinstance(value, str) and bool(CHAT.fullmatch(value))


def _valid_topic(value):
    return type(value) is int and 0 <= value <= 2147483647


def _valid_message_id(value, optional=False):
    return (optional and value is None) or (type(value) is int and 0 < value <= 2**53 - 1)


def _optional_string(value, maximum):
    return value is None or (isinstance(value, str) and len(value) <= maximum
                             and "\x00" not in value)


def validate_bundle(bundle: object) -> dict:
    if (not isinstance(bundle, dict)
            or set(bundle) != {"schema", "version", "routes", "archive_items"}
            or bundle["schema"] != "orbitsuite-metadata" or bundle["version"] != VERSION):
        raise ValueError("Unexpected export schema")
    routes, items = bundle["routes"], bundle["archive_items"]
    if not isinstance(routes, list) or not isinstance(items, list) or len(routes) > MAX_ROUTES or len(items) > MAX_ITEMS:
        raise ValueError("Export exceeds maximum record counts")
    for route in routes:
        if not isinstance(route, dict) or set(route) != set(ROUTE_FIELDS):
            raise ValueError("Malformed route record")
        if not _valid_chat(route["source"]) or not _valid_chat(route["dest"]) or route["source"] == route["dest"]:
            raise ValueError("Invalid route endpoint")
        if not _valid_topic(route["topic"]) or not _valid_topic(route["dest_topic"]):
            raise ValueError("Invalid route topic")
        if route["kind"] not in VALID_KINDS or route["mode"] not in VALID_MODES:
            raise ValueError("Invalid route mode/filter")
        for key, maximum in (("include_text", 200), ("exclude_text", 200),
                             ("caption_template", 1024), ("regex_include", 96),
                             ("regex_exclude", 96), ("mime_csv", 160), ("extension_csv", 160),
                             ("date_from", 10), ("date_to", 10), ("window_utc", 11),
                             ("weekdays_csv", 13)):
            if not _optional_string(route[key], maximum):
                raise ValueError("Unbounded route field")
        for key in ("regex_include", "regex_exclude"):
            pattern = route[key]
            if pattern is not None:
                if (re.search(r"[(){}+?]", pattern) or pattern.count(".*") > 1
                        or re.search(r"(?<!\.)\*", pattern) or re.search(r"\\[1-9]", pattern)):
                    raise ValueError("Unsafe imported route pattern")
        for flag in ("auto_topics", "sync_topic_titles", "propagate_edits"):
            if type(route[flag]) is not int or route[flag] not in (0, 1):
                raise ValueError("Invalid feature flag")
        if route["sender_id"] is not None and (
                not isinstance(route["sender_id"], str)
                or not route["sender_id"].isdigit() or len(route["sender_id"]) > 20):
            raise ValueError("Invalid sender id")
        for number in ("min_bytes", "max_bytes"):
            if route[number] is not None and (type(route[number]) is not int or route[number] < 0):
                raise ValueError("Invalid numeric filter")
    for item in items:
        if not isinstance(item, dict) or set(item) != set(ITEM_FIELDS):
            raise ValueError("Malformed archive metadata")
        if (not _valid_chat(item["source"]) or not _valid_chat(item["dest"])
                or not _valid_topic(item["dest_topic"])):
            raise ValueError("Invalid archive chat/topic")
        if not _valid_message_id(item["source_message_id"]) or not _valid_message_id(item["dest_message_id"], True):
            raise ValueError("Invalid archive message id")
        if type(item["saved_at"]) is not int or not 0 <= item["saved_at"] <= 2**53 - 1:
            raise ValueError("Invalid archive timestamp")
        if (not isinstance(item["media_kind"], str) or len(item["media_kind"]) > 32
                or not _optional_string(item["filename"], 255)
                or not _optional_string(item["caption_preview"], 1024)):
            raise ValueError("Invalid archive text metadata")
    return bundle


def import_bundle(connection: sqlite3.Connection, bundle: dict, *, confirmed: bool = False) -> dict:
    validate_bundle(bundle)
    expected = {"routes": len(bundle["routes"]), "archive_items": len(bundle["archive_items"])}
    if not confirmed:
        return {"dry_run": True, "offered": expected, "all_routes_disabled": True}
    route_fields = ROUTE_FIELDS
    item_fields = ITEM_FIELDS
    connection.execute("BEGIN IMMEDIATE")
    try:
        routes = 0
        for route in bundle["routes"]:
            # Never enable a route through an import, even if the exported route was enabled.
            data = {**route, "auto_topics": 0, "sync_topic_titles": 0,
                    "propagate_edits": 0}
            # Imported route fanout can form a cycle with local routes; reject it.
            existing = connection.execute("SELECT source,dest FROM routes").fetchall()
            graph = [(str(a), str(b)) for a, b in existing]
            stack = [data["dest"]]
            seen = set()
            while stack:
                chat = stack.pop()
                if chat == data["source"]:
                    raise ValueError("Import would create a forwarding cycle")
                if chat in seen:
                    continue
                seen.add(chat)
                stack.extend(b for a, b in graph if a == chat)
            placeholders = ",".join("?" for _ in route_fields)
            sql = "INSERT OR IGNORE INTO routes(" + ",".join(route_fields) + ",enabled) VALUES(" + placeholders + ",0)"
            routes += connection.execute(sql, [data[key] for key in route_fields]).rowcount
        items = 0
        for item in bundle["archive_items"]:
            placeholders = ",".join("?" for _ in item_fields)
            sql = "INSERT OR IGNORE INTO archive_items(" + ",".join(item_fields) + ") VALUES(" + placeholders + ")"
            items += connection.execute(sql, [item[key] for key in item_fields]).rowcount
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    return {"dry_run": False, "offered": expected,
            "imported": {"routes": routes, "archive_items": items},
            "all_imported_routes_disabled": True}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True, help="existing OrbitSuite SQLite database")
    parser.add_argument("action", choices=("export", "preview", "import"))
    parser.add_argument("file", type=Path, help="private JSON backup path")
    parser.add_argument("--confirm", action="store_true", help="required for import")
    args = parser.parse_args(argv)
    if not args.db.is_file():
        parser.error("SQLite database must already exist")
    with sqlite3.connect(f"file:{args.db.resolve()}?mode=rw", uri=True) as connection:
        if args.action == "export":
            data = export_bundle(connection)
            payload = json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf8")
            if len(payload) > MAX_IMPORT_BYTES:
                raise ValueError("Export too large")
            # Exclusive create, mode 0600. Never clobber another backup.
            fd = os.open(args.file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as handle:
                handle.write(payload)
            print(json.dumps({"exported": {"routes": len(data["routes"]),
                                         "archive_items": len(data["archive_items"])}}))
            return 0
        if args.file.stat().st_size > MAX_IMPORT_BYTES:
            raise ValueError("Backup JSON exceeds size limit")
        bundle = validate_bundle(json.loads(args.file.read_text(encoding="utf8")))
        if args.action == "import" and not args.confirm:
            parser.error("Import requires --confirm; use preview first")
        print(json.dumps(import_bundle(connection, bundle, confirmed=args.action == "import")))
        return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, sqlite3.DatabaseError, json.JSONDecodeError) as error:
        print("Archive portability refused: " + type(error).__name__, file=sys.stderr)
        sys.exit(2)
