import asyncio
import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace

from login import configuration, guided_login, parse_args
from vault import SessionVault


class GuidedLoginTests(unittest.TestCase):
    def test_explicit_flag_secrets_and_paths(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                parse_args([])
            with self.assertRaises(SystemExit):
                parse_args(["--login", "NOW"])
        self.assertEqual(parse_args(["--login", "CONFIRM"]).login, "CONFIRM")
        with self.assertRaises(ValueError):
            configuration({"ORBIT_SESSION_KEY": "short", "API_ID": "12", "API_HASH": "abcdefgh12345678"})

    def test_local_mock_login_reencrypts_and_removes_temporary_plaintext(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "session"
            env = {"ORBIT_SESSION_DIR": str(root), "ORBIT_SESSION_KEY": "a-private-session-passphrase",
                   "API_ID": "123456", "API_HASH": "1234567890abcdef1234567890abcdef"}
            messages = []
            opened = []

            class FakeClient:
                def __init__(self, name, *, api_id, api_hash, workdir):
                    self.file = Path(workdir) / (name + ".session")
                    self.api_id = api_id
                    self.api_hash = api_hash

                async def __aenter__(self):
                    self.file.write_bytes(b"fake sensitive Pyrogram session")
                    opened.append(self.file)
                    return self

                async def get_me(self):
                    return SimpleNamespace(id=55)

                async def __aexit__(self, *args):
                    return None

            result = asyncio.run(guided_login(parse_args(["--login", "CONFIRM"]), env,
                                              client_type=FakeClient, log=messages.append))
            self.assertTrue(result)
            self.assertTrue((root / "orbit-user.session.enc").is_file())
            self.assertTrue(all(not path.exists() for path in opened))
            self.assertNotIn(b"fake sensitive", (root / "orbit-user.session.enc").read_bytes())
            with SessionVault(root, env["ORBIT_SESSION_KEY"]) as vault:
                self.assertEqual((vault.workdir / "orbit-user.session").read_bytes(),
                                 b"fake sensitive Pyrogram session")
            self.assertTrue(asyncio.run(guided_login(parse_args(["--status"]), env)))
            self.assertFalse(any("1234567890abcdef" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
