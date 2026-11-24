"""Offline, metadata-only history report catalog: export, import, daily timeline.

This module never connects to Telegram. It never reads chat text or file bytes.
Only explicit local JSONL reports from the authorized history bridge are read.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import os
from pathlib import Path

from state import Report

MAX_CATALOG_BYTES = 32 * 1024 * 1024
MAX_RECORDS = 100_000
EVENTS = {"copied", "would_copy", "imported"}
MEDIA = {"document", "video", "photo", "audio", "voice", "animation",
         "sticker", "video_note", "text"}


def clean_record(item: object) -> dict:
    """Validate and retain only portable, bounded metadata fields."""
    if not isinstance(item, dict):
        raise ValueError("Record must be an object")
    source, message_id, kind = (item.get(key) for key in ("source", "message_id", "media_kind"))
    if not isinstance(source, str) or not 0 < len(source) <= 180:
        raise ValueError("Invalid source ID")
    if type(message_id) is not int or message_id < 1:
        raise ValueError("Invalid message ID")
    if not isinstance(kind, str) or kind not in MEDIA:
        raise ValueError("Invalid media kind")
    topic = item.get("topic")
    if topic is not None and (type(topic) is not int or topic < 0):
        raise ValueError("Invalid topic ID")
    result = {"source": source, "message_id": message_id, "media_kind": kind, "topic": topic}
    date = item.get("date")
    if date is not None:
        if not isinstance(date, str) or len(date) > 40:
            raise ValueError("Invalid date")
        try:
            value = datetime.fromisoformat(date.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Invalid date") from exc
        if value.tzinfo is None:
            raise ValueError("Date needs timezone")
        result["date"] = value.astimezone(timezone.utc).isoformat(timespec="seconds")
    filename = item.get("filename")
    if filename is not None:
        if not isinstance(filename, str) or len(filename) > 180:
            raise ValueError("Invalid filename")
        result["filename"] = filename
    return result


def load_report(path: Path) -> list[dict]:
    """Load a bounded local report, preserving only successful/preview records."""
    if path.is_symlink() or path.stat().st_size > MAX_CATALOG_BYTES:
        raise ValueError("Report is symlinked or exceeds catalog size limit")
    rows: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if line_number > MAX_RECORDS:
                raise ValueError("Too many report records")
            try:
                item = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError("Invalid JSONL report") from exc
            if isinstance(item, dict) and item.get("event") in EVENTS:
                rows.append(clean_record(item))
    return rows


def write_private_new(path: Path, value: dict) -> None:
    if path.is_symlink():
        raise ValueError("Refusing symlink output")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(value, handle, separators=(",", ":"), ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())


def export_catalog(report_path: Path, output_path: Path) -> int:
    """Export portable, sanitized metadata only; never overwrite a file."""
    rows = load_report(report_path)
    write_private_new(output_path, {"schema": "orbit-history-catalog", "version": 1,
                                    "records": rows})
    return len(rows)


def import_catalog(input_path: Path, report_path: Path) -> int:
    """Import catalog metadata into a *new* JSONL report (no Telegram operations)."""
    if input_path.is_symlink() or input_path.stat().st_size > MAX_CATALOG_BYTES:
        raise ValueError("Catalog is symlinked or exceeds size limit")
    try:
        source = json.loads(input_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError("Invalid JSON catalog") from exc
    if not isinstance(source, dict) or source.get("schema") != "orbit-history-catalog" or source.get("version") != 1:
        raise ValueError("Unsupported catalog format")
    items = source.get("records")
    if not isinstance(items, list) or len(items) > MAX_RECORDS:
        raise ValueError("Invalid catalog records")
    rows = [clean_record(item) for item in items]
    report = Report(report_path)
    try:
        for row in rows:
            report.write("imported", row)
    finally:
        report.close()
    return len(rows)


def timeline(report_path: Path, month: str | None = None) -> list[dict]:
    """Counts by day and source topic; dates absent from legacy reports are unknown."""
    if month is not None:
        try:
            datetime.strptime(month, "%Y-%m")
        except ValueError as exc:
            raise ValueError("Month must be YYYY-MM") from exc
    days: dict[tuple[str, str, int | None], Counter] = defaultdict(Counter)
    for row in load_report(report_path):
        day = row.get("date", "unknown")[:10]
        if month and not day.startswith(month):
            continue
        key = day, row["source"], row["topic"]
        days[key][row["media_kind"]] += 1
    return [{"day": day, "source": source, "topic": topic, "count": sum(counts.values()),
             "media": dict(sorted(counts.items()))}
            for (day, source, topic), counts in sorted(
                days.items(), key=lambda entry: (entry[0][0], entry[0][1], entry[0][2] or 0))]


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Offline, metadata-only history catalog")
    sub = parser.add_subparsers(dest="action", required=True)
    exp = sub.add_parser("export", help="Create portable JSON catalog from JSONL report")
    exp.add_argument("--report", type=Path, required=True)
    exp.add_argument("--output", type=Path, required=True)
    imp = sub.add_parser("import", help="Create JSONL report from portable catalog")
    imp.add_argument("--input", type=Path, required=True)
    imp.add_argument("--report", type=Path, required=True)
    view = sub.add_parser("timeline", help="View daily counts, per topic and media kind")
    view.add_argument("--report", type=Path, required=True)
    view.add_argument("--month", help="Optional UTC month in YYYY-MM format")
    args = parser.parse_args(argv)
    try:
        if args.action == "export":
            print("Exported metadata records:", export_catalog(args.report, args.output))
        elif args.action == "import":
            print("Imported metadata records:", import_catalog(args.input, args.report))
        else:
            print(json.dumps(timeline(args.report, args.month), indent=2))
    except (OSError, ValueError) as exc:
        parser.exit(2, f"Catalog operation failed: {exc}\n")


if __name__ == "__main__":
    main()
