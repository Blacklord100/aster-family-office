"""Backup failure/permission controls with mocked Docker and age, never real backups."""

import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest


class BackupControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aster-backup-controls-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.destination = root / "backup"
        self.destination.mkdir(mode=0o700)
        self.receipt = root / "receipts" / "backup.json"
        self.recipients = root / "recipients"
        self.recipients.write_text("synthetic recipient; not used by real age")
        self.backup = self.destination / "aster-20000101T000000Z.dump.age"
        self.mock("docker", "exit 7")
        self.mock("age", "cat >/dev/null; exit 7")
        self.mock("date", 'printf "20000101T000000Z\\n"')

    def mock(self, name, body):
        path = self.bin / name
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o700)

    def run_backup(self):
        env = {**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"]}
        env.pop("ASTER_BACKUP_REPLICA_DIR", None)
        return subprocess.run(
            ["bash", str(Path(__file__).with_name("backup.sh")),
             str(self.destination), str(self.recipients), str(self.receipt)],
            env=env, capture_output=True, text=True, timeout=10,
        )

    def assert_clean(self):
        self.assertFalse((self.destination / ".backup.lock").exists())
        self.assertEqual(list(self.destination.glob("*.partial")), [])
        self.assertEqual(list(self.receipt.parent.glob("*.partial.*")), [])

    def test_existing_backup_is_preserved_without_stale_lock(self):
        self.backup.write_text("preserved synthetic fixture")
        self.assertNotEqual(self.run_backup().returncode, 0)
        self.assertEqual(self.backup.read_text(), "preserved synthetic fixture")
        self.assert_clean()

    def test_failed_pipeline_cleans_partials_and_emits_no_receipt(self):
        self.assertNotEqual(self.run_backup().returncode, 0)
        self.assertFalse(self.receipt.exists())
        self.assertFalse(self.backup.exists())
        self.assert_clean()

    def test_private_receipt_directory_is_not_broadened(self):
        self.receipt.parent.mkdir(mode=0o700)
        result = self.run_backup()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("dedicated metadata directory", result.stderr)
        self.assertEqual(stat.S_IMODE(self.receipt.parent.stat().st_mode), 0o700)
        self.assert_clean()

    def test_metadata_is_readable_while_dump_stays_private(self):
        self.mock("docker", 'printf "synthetic dump fixture\\n"')
        self.mock("age", "cat")
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE(self.receipt.parent.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.backup.stat().st_mode), 0o600)
        self.assertEqual(json.loads(self.receipt.read_text())["result"], "passed")
        self.assert_clean()


class RestoreControls(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aster-restore-controls-")
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        self.log = root / "commands.log"
        self.backup = root / "synthetic.age"
        self.backup.write_text("synthetic encrypted input")
        self.identity = root / "identity"
        self.identity.write_text("synthetic identity")
        self.mock("docker", '''printf '%s\\n' "$*" >> "$ASTER_TEST_LOG"
case "$*" in
  *createdb*) test "$ASTER_FAIL_STAGE" != create ;;
  *pg_restore*) cat >/dev/null; test "$ASTER_FAIL_STAGE" != restore ;;
  *psql*) cat >> "$ASTER_TEST_LOG" ;;
esac''')
        self.mock("age", 'test "$ASTER_FAIL_STAGE" != decrypt || exit 8; printf "synthetic decrypted dump\\n"')

    def mock(self, name, body):
        script = self.bin / name
        script.write_text("#!/bin/sh\n" + body + "\n")
        script.chmod(0o700)

    def run_restore(self, fail=""):
        return subprocess.run(
            ["bash", str(Path(__file__).with_name("restore-drill.sh")), str(self.backup), str(self.identity), "aster_restore_fixture"],
            env={**os.environ, "PATH": str(self.bin) + os.pathsep + os.environ["PATH"], "ASTER_TEST_LOG": str(self.log), "ASTER_FAIL_STAGE": fail},
            capture_output=True, text=True, timeout=10,
        )

    def test_restored_database_is_closed_until_access_controls_are_applied(self):
        result = self.run_restore()
        self.assertEqual(result.returncode, 0, result.stderr)
        commands = self.log.read_text()
        self.assertLess(commands.index("--connection-limit=0"), commands.index("pg_restore"))
        self.assertLess(commands.index("REVOKE ALL"), commands.index("pg_restore"))
        self.assertLess(commands.index("pg_restore"), commands.index("GRANT CONNECT"))
        self.assertLess(commands.index("GRANT CONNECT"), commands.index("CONNECTION LIMIT -1"))

    def test_failed_restore_or_decryption_never_reopens_database(self):
        for stage in ["restore", "decrypt"]:
            with self.subTest(stage=stage):
                self.log.unlink(missing_ok=True)
                result = self.run_restore(stage)
                self.assertNotEqual(result.returncode, 0)
                commands = self.log.read_text()
                self.assertIn("--connection-limit=0", commands)
                self.assertNotIn("CONNECTION LIMIT -1", commands)
                self.assertNotIn("GRANT CONNECT", commands)
                self.assertNotIn("dropdb", commands)

    def test_failed_creation_does_not_touch_existing_database(self):
        result = self.run_restore("create")
        self.assertNotEqual(result.returncode, 0)
        commands = self.log.read_text()
        self.assertNotIn("pg_restore", commands)
        self.assertNotIn("REVOKE ALL", commands)
        self.assertNotIn("dropdb", commands)


if __name__ == "__main__":
    unittest.main()
