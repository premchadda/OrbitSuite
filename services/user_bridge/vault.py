"""Optional encrypted, local-only Pyrogram SQLite session vault.

The session must temporarily exist on disk while Pyrogram opens SQLite; the
vault encrypts it after the client closes, wipes the temporary work directory
on normal exit, and never logs credentials. A force kill can prevent cleanup:
use a trusted encrypted filesystem, preferably a RAM-backed runtime directory.
"""
from __future__ import annotations

from contextlib import AbstractContextManager
import os
from pathlib import Path
import tempfile

MAGIC = b"ORBVAULT1"


def _key(passphrase: str, salt: bytes) -> bytes:
    if len(passphrase) < 16:
        raise ValueError("ORBIT_SESSION_KEY must be at least 16 characters")
    try:
        from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    except ImportError as exc:
        raise RuntimeError("Install cryptography in the isolated user-bridge environment") from exc
    return Scrypt(salt=salt, length=32, n=2**14, r=8, p=1).derive(passphrase.encode("utf-8"))


def encrypt_session(data: bytes, passphrase: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    salt = os.urandom(16)
    nonce = os.urandom(12)
    return MAGIC + salt + nonce + AESGCM(_key(passphrase, salt)).encrypt(nonce, data, MAGIC)


def decrypt_session(data: bytes, passphrase: str) -> bytes:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    if not data.startswith(MAGIC) or len(data) <= len(MAGIC) + 16 + 12 + 16:
        raise ValueError("Invalid encrypted session")
    salt = data[len(MAGIC):len(MAGIC)+16]
    nonce = data[len(MAGIC)+16:len(MAGIC)+28]
    try:
        return AESGCM(_key(passphrase, salt)).decrypt(nonce, data[len(MAGIC)+28:], MAGIC)
    except Exception as exc:
        raise ValueError("Wrong session key or corrupted vault") from exc


class SessionVault(AbstractContextManager):
    def __init__(self, root: Path, passphrase: str, *, filename: str = "orbit-user"):
        if len(passphrase) < 16:
            raise ValueError("ORBIT_SESSION_KEY must be at least 16 characters")
        self.root = root
        self.passphrase = passphrase
        self.filename = filename
        self.encrypted = root / (filename + ".session.enc")
        self._temp: tempfile.TemporaryDirectory | None = None
        self._lock: Path = root / (filename + ".lock")
        self.logged_out = False
        self.workdir: Path | None = None

    def __enter__(self) -> "SessionVault":
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if self.encrypted.is_symlink():
            raise ValueError("Refusing symlink vault")
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
        try:
            fd = os.open(self._lock, flags, 0o600)
        except FileExistsError as exc:
            raise RuntimeError("Session vault already in use; check for another process") from exc
        os.close(fd)
        try:
            runtime_root = os.environ.get("ORBIT_SECURE_RUNTIME_DIR")
            preferred = Path(runtime_root) if runtime_root else self.root
            preferred.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._temp = tempfile.TemporaryDirectory(prefix="orbit-client-", dir=preferred)
            self.workdir = Path(self._temp.name)
            if self.encrypted.exists():
                plaintext = decrypt_session(self.encrypted.read_bytes(), self.passphrase)
                target = self.workdir / (self.filename + ".session")
                fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                with os.fdopen(fd, "wb") as handle:
                    handle.write(plaintext)
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        try:
            if self._temp and self.workdir:
                source = self.workdir / (self.filename + ".session")
                if self.logged_out:
                    self.encrypted.unlink(missing_ok=True)
                elif source.exists() and not source.is_symlink():
                    payload = encrypt_session(source.read_bytes(), self.passphrase)
                    fd, staging = tempfile.mkstemp(prefix=".session-vault-", dir=self.root)
                    try:
                        os.fchmod(fd, 0o600)
                        with os.fdopen(fd, "wb") as handle:
                            handle.write(payload)
                            handle.flush()
                            os.fsync(handle.fileno())
                        os.replace(staging, self.encrypted)
                    finally:
                        if os.path.exists(staging):
                            os.unlink(staging)
        finally:
            if self._temp:
                self._temp.cleanup()
                self._temp = None
            self._lock.unlink(missing_ok=True)

    def logout_local(self) -> None:
        """Call only after Telegram confirms session invalidation."""
        self.logged_out = True
