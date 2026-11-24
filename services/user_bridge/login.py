"""Guided *local only* Pyrogram sign-in with encrypted on-disk session vault.

Run on your own trusted computer. Pyrogram handles OTP/2FA interactively;
OrbitSuite never receives, stores, forwards, logs or requests those codes.
"""
from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path
import sys

from vault import SessionVault


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Local encrypted Telegram history session setup")
    exclusive = parser.add_mutually_exclusive_group(required=True)
    exclusive.add_argument("--login", choices=["CONFIRM"], help="Open interactive local OTP/2FA login")
    exclusive.add_argument("--status", action="store_true", help="Check only whether local encrypted vault exists")
    args = parser.parse_args(argv)
    return args


def configuration(env, *, home=None) -> tuple[Path, str, int, str]:
    root = Path(env.get("ORBIT_SESSION_DIR") or str((home or Path.home()) / ".local/share/orbitsuite/sessions"))
    key = str(env.get("ORBIT_SESSION_KEY") or "")
    api_id = str(env.get("API_ID") or "")
    api_hash = str(env.get("API_HASH") or "")
    if len(key) < 16 or not api_id.isdecimal() or not 1 <= int(api_id) <= 2**31 - 1 or len(api_hash) < 16:
        raise ValueError("Set private ORBIT_SESSION_KEY (16+), numeric API_ID and local API_HASH first")
    if root.is_symlink():
        raise ValueError("Session directory cannot be a symlink")
    return root, key, int(api_id), api_hash


async def guided_login(args, env, *, client_type=None, log=print):
    os.umask(0o077)
    root = Path(env.get("ORBIT_SESSION_DIR") or str(Path.home() / ".local/share/orbitsuite/sessions"))
    if args.status:
        exists = (root / "orbit-user.session.enc").is_file()
        log("Encrypted local Telegram session present." if exists else "No encrypted local session found.")
        return exists
    if args.login != "CONFIRM":
        raise ValueError("Login requires explicit CONFIRM")
    root, key, api_id, api_hash = configuration(env)
    if client_type is None:
        if not sys.stdin.isatty():
            raise RuntimeError("Interactive login needs a trusted local terminal")
        try:
            from pyrogram import Client
        except ImportError as exc:
            raise RuntimeError("Install the isolated history bridge requirements first") from exc
        client_type = Client
    log("Starting private local Telegram login. Enter OTP/2FA only at the trusted Pyrogram prompt.")
    with SessionVault(root, key) as vault:
        async with client_type("orbit-user", api_id=api_id, api_hash=api_hash,
                               workdir=str(vault.workdir)) as client:
            who = await client.get_me()
            if not getattr(who, "id", None):
                raise RuntimeError("Telegram did not verify the local account")
    log("Telegram account verified. Encrypted session stored locally; no OTP was retained.")
    return True


if __name__ == "__main__":
    try:
        asyncio.run(guided_login(parse_args(), os.environ))
    except (ValueError, RuntimeError) as exc:
        raise SystemExit(str(exc)) from exc
