"""Opt-in manual history copier for chats where the account has permission.

Default mode inspects messages without sending anything. No auto-join,
multi-account rotation, protected-content bypass, or silent FloodWait retry.
Credentials and session files stay on the operator's own machine.
"""
from __future__ import annotations

import argparse
import asyncio
from contextlib import ExitStack, nullcontext
from datetime import datetime, timezone
import os
from pathlib import Path
import sys

from state import Checkpoint, Report, file_identity, metadata_record
from vault import SessionVault


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OrbitSuite manual history bridge")
    parser.add_argument("--source", help="Source group/channel ID or username")
    parser.add_argument("--dest", help="Destination group ID, channel ID, or 'me'")
    parser.add_argument("--first", type=int, help="First known message ID")
    parser.add_argument("--last", type=int, help="Last known message ID (inclusive)")
    parser.add_argument("--topic", type=int, default=0, help="Only copy messages in this source topic (0=any)")
    parser.add_argument("--delay", type=float, default=5.0, help="Seconds between sends (minimum 3)")
    parser.add_argument("--execute", action="store_true", help="Explicitly enable copying")
    parser.add_argument("--checkpoint", type=Path, help="Durable metadata-only JSON checkpoint path")
    parser.add_argument("--resume", action="store_true", help="Resume a matching existing checkpoint")
    parser.add_argument("--skip-uncertain", action="store_true", help="After verifying the destination, advance past an uncertain send without retry")
    parser.add_argument("--retry-uncertain", choices=["CONFIRM"], help="After verifying the destination, explicitly permit re-sending an uncertain ID (duplicate risk)")
    parser.add_argument("--report", type=Path, help="Write minimal JSONL preview/copy/skip events")
    parser.add_argument("--include-filename", action="store_true", help="Include bounded media filenames in local report")
    parser.add_argument("--dedup-file-ids", action="store_true", help="Skip repeated hashed Telegram file_unique_id values")
    parser.add_argument("--scheduled-at", help="One-shot scheduled run, ISO-8601 timestamp with timezone")
    parser.add_argument("--allow-unencrypted-session", action="store_true", help="Opt out of encrypted local session vault; not recommended")
    parser.add_argument("--logout", choices=["CONFIRM"], help="Explicitly revoke this Telegram user session")
    args = parser.parse_args(argv)
    if not args.logout:
        if not args.source or not args.dest or args.first is None or args.last is None:
            parser.error("Source, destination, first and last IDs are required")
        if args.first < 1 or args.last < args.first or args.last - args.first + 1 > 50:
            parser.error("Range must contain 1–50 positive message IDs")
    if args.topic < 0 or args.delay < 3:
        parser.error("Topic must be nonnegative and send delay at least 3 seconds")
    if not args.logout and args.source == args.dest:
        parser.error("Source and destination must differ")
    if args.execute and not args.checkpoint:
        parser.error("Executing history copies requires --checkpoint to guard ambiguous sends")
    if args.resume and not args.checkpoint:
        parser.error("--resume requires --checkpoint")
    if (args.skip_uncertain or args.retry_uncertain) and not args.resume:
        parser.error("Uncertain-send reconciliation requires --resume")
    if args.scheduled_at:
        try:
            scheduled = datetime.fromisoformat(args.scheduled_at.replace("Z", "+00:00"))
        except ValueError:
            parser.error("--scheduled-at must be a valid ISO-8601 timestamp")
        if scheduled.tzinfo is None:
            parser.error("--scheduled-at needs an explicit timezone")
        seconds = (scheduled - datetime.now(timezone.utc)).total_seconds()
        if seconds > 30 * 86400:
            parser.error("--scheduled-at cannot be more than 30 days ahead")
    return args


def eligible_message(message, topic: int) -> bool:
    if not message or getattr(message, "empty", False):
        return False
    if getattr(message, "has_protected_content", False):
        return False
    if getattr(getattr(message, "chat", None), "has_protected_content", False):
        return False
    if topic and getattr(message, "message_thread_id", None) != topic:
        return False
    return True


def identity_for(args: argparse.Namespace) -> dict:
    return {"source": args.source, "dest": args.dest, "first": args.first, "last": args.last,
            "topic": args.topic, "execute": bool(args.execute)}


def category(message: object, topic: int) -> str | None:
    if not message or getattr(message, "empty", False):
        return "empty"
    if getattr(message, "has_protected_content", False) or getattr(
            getattr(message, "chat", None), "has_protected_content", False):
        return "protected"
    if topic and getattr(message, "message_thread_id", None) != topic:
        return "wrong_topic"
    return None


async def copy_range(args: argparse.Namespace, client, checkpoint: Checkpoint | None = None,
                     report: Report | None = None, flood_wait_class: type | None = None) -> dict:
    """Purely orchestrated authorized scan; accepts a fake client in tests."""
    copied = skipped = previewed = 0
    first = checkpoint.state.next_id if checkpoint else args.first
    known_files = set(checkpoint.state.seen_files) if checkpoint else set()
    failure = None
    for message_id in range(first, args.last + 1):
        try:
            message = await client.get_messages(args.source, message_id)
        except Exception as exc:
            failure = "flood_wait" if flood_wait_class and isinstance(exc, flood_wait_class) else "access_error"
            if report:
                report.write(failure, {"message_id": message_id, "reason": type(exc).__name__})
            break
        reason = category(message, args.topic)
        fingerprint = file_identity(message) if not reason and args.dedup_file_ids else None
        if not reason and fingerprint and fingerprint in known_files:
            reason = "duplicate_file"
        if reason:
            skipped += 1
            if checkpoint:
                checkpoint.record(message_id, "skipped")
            if report:
                report.write("skipped", {"message_id": message_id, "reason": reason})
            continue

        item = metadata_record(message, str(args.source), message_id,
                               include_filename=args.include_filename)
        if not args.execute:
            previewed += 1
            if fingerprint:
                known_files.add(fingerprint)
            if checkpoint:
                checkpoint.record(message_id, "previewed", file_hash=fingerprint)
            if report:
                report.write("would_copy", item)
            else:
                print("Would copy message:", message_id)
            continue

        if checkpoint:
            checkpoint.mark_inflight(message_id)
        try:
            await client.copy_message(
                chat_id=args.dest, from_chat_id=args.source, message_id=message_id)
        except Exception as exc:
            failure = "flood_wait" if flood_wait_class and isinstance(exc, flood_wait_class) else "uncertain_send"
            if report:
                report.write(failure, {"message_id": message_id, "reason": type(exc).__name__})
            # Never automatically retry a potentially successful copy.
            break
        copied += 1
        if fingerprint:
            known_files.add(fingerprint)
        if checkpoint:
            checkpoint.record(message_id, "copied", file_hash=fingerprint)
        if report:
            report.write("copied", item)
        if message_id < args.last:
            await asyncio.sleep(args.delay)
    return {"copied": copied, "skipped": skipped, "previewed": previewed,
            "failure": failure, "next_id": checkpoint.state.next_id if checkpoint else None}


async def run(args: argparse.Namespace) -> None:
    try:
        from pyrogram import Client
        from pyrogram.errors import FloodWait
    except ImportError as exc:
        raise SystemExit("Install this bridge in its own venv: pip install -r requirements.txt") from exc
    api_id = os.getenv("API_ID")
    api_hash = os.getenv("API_HASH")
    if not api_id or not api_hash or not api_id.isdecimal():
        raise SystemExit("Set numeric API_ID and API_HASH locally; never send a session string to the bot")
    os.umask(0o077)
    root = Path(os.environ.get("ORBIT_SESSION_DIR", str(Path.home() / ".local/share/orbitsuite/sessions")))
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    key = os.environ.get("ORBIT_SESSION_KEY", "")
    if not key and not args.allow_unencrypted_session:
        raise SystemExit("Set ORBIT_SESSION_KEY for encrypted local sessions, or explicitly allow unencrypted storage")
    if args.scheduled_at:
        scheduled = datetime.fromisoformat(args.scheduled_at.replace("Z", "+00:00"))
        seconds = max(0, (scheduled - datetime.now(timezone.utc)).total_seconds())
        if seconds:
            print("Scheduled one-shot run; waiting until UTC:", scheduled.astimezone(timezone.utc).isoformat())
            await asyncio.sleep(seconds)
    if args.logout and key and not (root / "orbit-user.session.enc").is_file():
        raise SystemExit("No encrypted local session exists to revoke")
    if args.logout and not key and not (root / "orbit-user.session").is_file():
        raise SystemExit("No local session exists to revoke")
    session_context = SessionVault(root, key) if key else nullcontext()
    with ExitStack() as stack:
        checkpoint = Checkpoint(args.checkpoint, identity_for(args)) if args.checkpoint and not args.logout else None
        if checkpoint:
            stack.enter_context(checkpoint.exclusive())
            checkpoint.start(args.first, resume=args.resume,
                             skip_uncertain=args.skip_uncertain,
                             retry_uncertain=bool(args.retry_uncertain))
        report = Report(args.report, resume=args.resume) if args.report and not args.logout else None
        if report:
            stack.callback(report.close)
        print("Mode:", "LOGOUT" if args.logout else "EXECUTE" if args.execute else "DRY RUN")
        with session_context as vault:
            workdir = vault.workdir if key else root
            async with Client("orbit-user", api_id=int(api_id), api_hash=api_hash,
                              workdir=str(workdir)) as client:
                if args.logout:
                    await client.log_out()
                    if key:
                        vault.logout_local()
                    print("The local Telegram user session was revoked")
                    return
                outcome = await copy_range(args, client, checkpoint, report, FloodWait)
                print("Copied:", outcome["copied"], "Skipped:", outcome["skipped"],
                      "Previewed:", outcome["previewed"])
                if outcome["failure"]:
                    print("Stopped on", outcome["failure"],
                          "; inspect destination before any retry", file=sys.stderr)


if __name__ == "__main__":
    asyncio.run(run(parse_args()))
