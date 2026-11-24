import os
from pathlib import Path
import tempfile
import unittest

from vault import SessionVault, decrypt_session, encrypt_session


class VaultTests(unittest.TestCase):
    def test_encrypt_decrypt_and_tamper_protection(self):
        payload = b"not real Telegram secrets"
        ciphertext = encrypt_session(payload, "a-long-private-passphrase")
        self.assertNotIn(payload, ciphertext)
        self.assertEqual(decrypt_session(ciphertext, "a-long-private-passphrase"), payload)
        with self.assertRaises(ValueError):
            decrypt_session(ciphertext, "the wrong passphrase")
        with self.assertRaises(ValueError):
            decrypt_session(ciphertext[:-1], "a-long-private-passphrase")

    def test_vault_roundtrip_and_cleanup(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            with SessionVault(root, "a-long-private-passphrase") as vault:
                source = vault.workdir / "orbit-user.session"
                source.write_bytes(b"fake local sqlite session")
                os.chmod(source, 0o600)
                directory = vault.workdir
            self.assertFalse(directory.exists())
            encrypted = root / "orbit-user.session.enc"
            self.assertTrue(encrypted.exists())
            self.assertNotIn(b"fake local sqlite", encrypted.read_bytes())
            with SessionVault(root, "a-long-private-passphrase") as resumed:
                self.assertEqual((resumed.workdir / "orbit-user.session").read_bytes(),
                                 b"fake local sqlite session")
                resumed.logout_local()
            self.assertFalse(encrypted.exists())

    def test_vault_refuses_short_keys_and_concurrent_open(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(ValueError):
                SessionVault(Path(folder), "short")
            with SessionVault(Path(folder), "a-long-private-passphrase"):
                with self.assertRaises(RuntimeError):
                    with SessionVault(Path(folder), "a-long-private-passphrase"):
                        pass


if __name__ == "__main__":
    unittest.main()
