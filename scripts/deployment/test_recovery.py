"""功能：纯本地验证部署保护边界，不连接 PG、不启动应用或服务。
RecoveryTests 用临时文件验证权限、指纹和备份完整性；OwnershipTests 用受控进程替身
验证拒绝启动、子进程先清理后解锁以及锁连接失联；RollbackTests 使用含新增事实的
数据库替身及真实临时资产，验证最新恢复点、候选绑定、持锁核对和资产变化拒绝。
真实PG恢复由 README 的独立验收执行。
"""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


r = module("recovery")
o = module("single_owner")


class RecoveryTests(unittest.TestCase):
    def test_symlink_asset_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "file").write_text("original")
            (root / "link").symlink_to(root / "file")
            with self.assertRaisesRegex(r.Refusal, "asset_symlink"):
                r.tree_files(root)

    def test_permissions_are_checked_without_chmod(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "target.json"
            p.write_text("{}")
            p.chmod(0o644)
            with self.assertRaisesRegex(r.Refusal, "private_file"):
                r.read_json(p)
            self.assertEqual(p.stat().st_mode & 0o777, 0o644)

    def test_epoch_change_is_not_allowed(self):
        before = {"columns": {}, "tables": {"memory_native_epoch": {"rows": 1, "sha256": "a"}}, "sequences": {}}
        pg = Mock()
        pg.snapshot.return_value = {**before, "tables": {"memory_native_epoch": {"rows": 1, "sha256": "b"}}}
        with self.assertRaisesRegex(r.Refusal, "preserved_table_changed_memory_native_epoch"):
            r.compare(pg, {"schema": "public", "snapshot": before}, True)

    def test_added_columns_use_original_projection(self):
        before = {"columns": {"raw": ["id", "body"]}, "tables": {"raw": {"rows": 1, "sha256": "a"}}, "sequences": {}}
        pg = Mock()
        pg.snapshot.return_value = before
        self.assertEqual(r.compare(pg, {"schema": "public", "snapshot": before}), before)
        pg.snapshot.assert_called_once_with("public", before)

    def test_sequence_change_is_not_allowed(self):
        before = {"columns": {}, "tables": {}, "sequences": {"queue_seq": "15:true"}}
        pg = Mock()
        pg.snapshot.return_value = {**before, "sequences": {"queue_seq": "16:true"}}
        with self.assertRaisesRegex(r.Refusal, "sequence_changed"):
            r.compare(pg, {"schema": "public", "snapshot": before})

    def test_kind_contract_only_allowed_for_migration(self):
        before = {"columns": {}, "tables": {"information_kinds": {"sha256": "a"}}, "sequences": {}}
        pg = Mock()
        pg.snapshot.return_value = {**before, "tables": {"information_kinds": {"sha256": "b"}}}
        r.compare(pg, {"schema": "public", "snapshot": before}, True)
        with self.assertRaises(r.Refusal):
            r.compare(pg, {"schema": "public", "snapshot": before})

    def test_restore_requires_globals_review_before_postgres(self):
        receipt = {"files": {"globals.sql": "expected"}}
        with patch.object(r, "verify_backup", return_value=receipt), patch.object(r, "Postgres") as pg:
            with self.assertRaisesRegex(r.Refusal, "globals_review"):
                r.restore({"configuration_review": {"pluginNames": ["kaguya/runtime"]}}, "backup", "hash", "/scratch", "different")
            pg.assert_not_called()

    def test_running_service_refuses_backup_before_database(self):
        with patch.object(r, "stopped", side_effect=r.Refusal("application_not_stopped")), patch.object(r, "source") as pg:
            with self.assertRaisesRegex(r.Refusal, "not_stopped"):
                r.backup({}, "unused")
            pg.assert_not_called()

    def test_tampered_backup_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            for name in ("database.dump", "globals.sql"):
                (root / name).write_text("initial")
                (root / name).chmod(0o600)
            r.write_json(root / "receipt.json", {"files": {n: r.digest(root / n) for n in ("database.dump", "globals.sql")}, "assets": {}})
            expected = r.digest(root / "receipt.json")
            r.verify_backup(root, expected)
            (root / "database.dump").write_text("modified")
            with self.assertRaisesRegex(r.Refusal, "backup_file_changed"):
                r.verify_backup(root, expected)

    def test_asset_mode_and_empty_directory_are_preserved(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            (root / "empty").mkdir()
            (root / "script").write_text("executable")
            (root / "script").chmod(0o700)
            before = r.tree_files(root)
            self.assertEqual(before["empty"]["type"], "directory")
            self.assertEqual(before["script"]["mode"], 0o700)
            (root / "script").chmod(0o600)
            self.assertNotEqual(before, r.tree_files(root))

    def test_heartbeat_checks_lock_not_just_process_liveness(self):
        pg = object.__new__(r.Postgres)
        pg.lease_pid = 55
        pg.lease_process = Mock()
        pg.lease_process.poll.return_value = None
        pg.lease_process.stdout.readline.return_value = b"0\n"
        with patch.object(r.select, "select", return_value=([pg.lease_process.stdout], [], [])):
            with self.assertRaisesRegex(r.Refusal, "ownership_connection_lost"):
                pg.heartbeat()

    def test_scratch_cannot_overlap_asset_roots(self):
        receipt = {"files": {"globals.sql": "hash"}, "source": {"database": "app", "data_directory": "/not-used"}}
        plan = {"configuration_review": {"pluginNames": ["kaguya/runtime"]}, "asset_roots": {"config": "/synthetic-config"}}
        with patch.object(r, "verify_backup", return_value=receipt), patch.object(r, "Postgres") as pg:
            with self.assertRaisesRegex(r.Refusal, "scratch_overlaps_source"):
                r.restore(plan, "/separate-backup", "hash", "/synthetic-config/scratch", "hash")
            pg.assert_not_called()


class RollbackTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        roots = {}
        for name in ("config", "media", "tools"):
            root = self.root / name
            root.mkdir(mode=0o700)
            (root / "new-after-upgrade").write_text("new " + name)
            roots[name] = str(root)
        self.plan = {"source": {"identity": {"system_identifier": "synthetic-new-cluster"}},
                     "rollback_sha": "a" * 40, "asset_roots": roots}
        self.snapshot = {"columns": {"information_atoms": ["information_id", "payload"]},
                         "tables": {"information_atoms": {"rows": 2, "sha256": "old-plus-new-fact"}},
                         "sequences": {"lifecycle_position": "2:true"}}
        self.receipt = {"schema": "public", "snapshot": self.snapshot,
                        "schemaCatalog": {"rows": 3, "sha256": "upgraded-schema"},
                        "assets": {n: r.tree_files(p) for n, p in roots.items()}}
        self.receipt_hash = "b" * 64
        self.compat = {"backup_receipt_sha256": self.receipt_hash, "candidate_sha": "a" * 40,
                       "verified_on_scratch": True, "pending_unknown_reconciled": True}
        self.events = []
        self.locked = False
        self.pg = Mock()
        @contextlib.contextmanager
        def lease(identity):
            self.assertEqual(identity, self.plan["source"]["identity"])
            self.assertFalse(self.locked)
            self.locked = True
            self.events.append("locked")
            try:
                yield
            finally:
                self.locked = False
                self.events.append("unlocked")
        def observe(name, value=None):
            def call(*_args):
                self.assertTrue(self.locked, "database observation escaped the lease")
                self.events.append(name)
                return value
            return call
        self.pg.lease.side_effect = lease
        self.pg.guard.side_effect = observe("guard")
        self.pg.idle.side_effect = observe("idle")
        self.pg.snapshot.side_effect = observe("snapshot", self.snapshot)
        self.pg.schema_fingerprint.side_effect = observe("schema", self.receipt["schemaCatalog"])

    def check(self):
        return r.check_rollback(self.plan, self.pg, self.receipt, self.receipt_hash, self.compat)

    def test_latest_checkpoint_preserves_new_rows_and_assets_under_one_lease(self):
        original = r.tree_files
        def inspect_live(path):
            self.assertTrue(self.locked)
            self.events.append("asset")
            return original(path)
        with patch.object(r, "tree_files", side_effect=inspect_live):
            result = self.check()
        self.assertEqual(result, {"preserved": True, "tables": 1, "runtime_started": False})
        self.assertEqual(self.events, ["locked", "guard", "idle", "snapshot", "schema",
                                       "asset", "asset", "asset", "guard", "idle", "unlocked"])
        self.pg.snapshot.assert_called_once_with("public", self.snapshot)
        self.assertEqual((self.root / "tools" / "new-after-upgrade").read_text(), "new tools")

    def test_pre_upgrade_checkpoint_refuses_to_discard_new_fact(self):
        self.receipt["snapshot"] = {**self.snapshot,
            "tables": {"information_atoms": {"rows": 1, "sha256": "only-old-fact"}},
            "sequences": {"lifecycle_position": "1:true"}}
        with self.assertRaisesRegex(r.Refusal, "preserved_table_changed_information_atoms"):
            self.check()
        self.assertEqual(self.events[-1], "unlocked")

    def test_missing_or_modified_live_artifact_is_rejected(self):
        for change in ("modified", "deleted"):
            with self.subTest(change=change):
                asset = self.root / "tools" / "new-after-upgrade"
                if change == "modified":
                    asset.write_text("changed after latest backup")
                else:
                    asset.unlink()
                with self.assertRaisesRegex(r.Refusal, "rollback_asset_changed_tools"):
                    self.check()
        self.assertFalse(self.locked)

    def test_changed_live_permissions_are_rejected(self):
        asset = self.root / "media" / "new-after-upgrade"
        asset.chmod((asset.stat().st_mode & 0o777) ^ 0o100)
        with self.assertRaisesRegex(r.Refusal, "rollback_asset_changed_media"):
            self.check()

    def test_missing_or_extra_asset_root_is_rejected_before_lock(self):
        for roots in ({"config": self.plan["asset_roots"]["config"]},
                      {**self.plan["asset_roots"], "unrecorded": str(self.root)}):
            with self.subTest(roots=tuple(roots)):
                plan = {**self.plan, "asset_roots": roots}
                with self.assertRaisesRegex(r.Refusal, "rollback_asset_roots_mismatch"):
                    r.check_rollback(plan, self.pg, self.receipt, self.receipt_hash, self.compat)
        self.pg.lease.assert_not_called()

    def test_candidate_and_receipt_bindings_are_required(self):
        for key, value in (("candidate_sha", "c" * 40),
                           ("backup_receipt_sha256", "d" * 64),
                           ("verified_on_scratch", False),
                           ("pending_unknown_reconciled", False)):
            with self.subTest(key=key):
                compat = {**self.compat, key: value}
                with self.assertRaisesRegex(r.Refusal, "rollback_compatibility_required"):
                    r.check_rollback(self.plan, self.pg, self.receipt, self.receipt_hash, compat)
        self.pg.lease.assert_not_called()

    def test_schema_changed_with_same_rows_is_rejected(self):
        self.pg.schema_fingerprint.side_effect = None
        self.pg.schema_fingerprint.return_value = {"rows": 3, "sha256": "missing-constraint"}
        with self.assertRaisesRegex(r.Refusal, "rollback_schema_changed"):
            self.check()
        self.assertEqual(self.events[-1], "unlocked")

    def test_ownership_loss_at_final_guard_is_not_success(self):
        guards = 0
        def guard(_identity):
            nonlocal guards
            self.assertTrue(self.locked)
            guards += 1
            if guards == 2:
                raise r.Refusal("ownership_connection_lost")
        self.pg.guard.side_effect = guard
        with self.assertRaisesRegex(r.Refusal, "ownership_connection_lost"):
            self.check()
        self.assertEqual(self.events[-1], "unlocked")

    def test_busy_owner_rejects_before_any_snapshot(self):
        self.pg.lease.side_effect = r.Refusal("ownership_unavailable")
        with self.assertRaisesRegex(r.Refusal, "ownership_unavailable"):
            self.check()
        self.pg.snapshot.assert_not_called()

    def test_compare_cli_observations_are_inside_lease(self):
        argv = ["recovery.py", "compare", "--plan", "/plan", "--directory", "/backup",
                "--receipt-sha256", self.receipt_hash]
        with patch.object(r.sys, "argv", argv), \
             patch.object(r, "read_json", return_value={**self.plan, "version": 1}), \
             patch.object(r, "verify_backup", return_value=self.receipt), \
             patch.object(r, "stopped") as stopped, \
             patch.object(r, "source", return_value=self.pg), \
             patch.object(r.sys, "stdout", new_callable=io.StringIO) as output:
            r.main()
        stopped.assert_called_once()
        self.assertTrue(json.loads(output.getvalue())["preserved"])
        self.assertEqual(self.events, ["locked", "guard", "idle", "snapshot", "guard", "idle", "unlocked"])

    def test_rollback_cli_still_requires_stopped_service(self):
        argv = ["recovery.py", "rollback-check", "--plan", "/plan", "--directory", "/backup",
                "--receipt-sha256", self.receipt_hash, "--compatibility-receipt", "/compat"]
        with patch.object(r.sys, "argv", argv), \
             patch.object(r, "read_json", return_value={**self.plan, "version": 1}), \
             patch.object(r, "verify_backup", return_value=self.receipt), \
             patch.object(r, "stopped", side_effect=r.Refusal("application_not_stopped")), \
             patch.object(r, "source") as source:
            with self.assertRaisesRegex(r.Refusal, "application_not_stopped"):
                r.main()
        source.assert_not_called()


class OwnershipTests(unittest.TestCase):
    def test_cgroup_members_include_detached_descendants(self):
        with tempfile.TemporaryDirectory() as d:
            group = Path(d)
            (group / "cgroup.procs").write_text("1\n2\n3\n")
            (group / "nested").mkdir()
            (group / "nested" / "cgroup.procs").write_text("4\n")
            self.assertEqual(o.members(group, {1, 2}), {3, 4})

    def test_child_cleanup_happens_before_unlock(self):
        events = []
        pg = Mock()
        connection = Mock()
        connection.poll.return_value = None
        @contextlib.contextmanager
        def lease(_):
            events.append("locked")
            try:
                yield connection
            finally:
                events.append("unlocked")
        pg.lease.side_effect = lease
        child = Mock()
        child.poll.return_value = None
        plan = {"release_receipt": "receipt", "release_receipt_sha256": "hash", "release_root": "/release", "source": {"identity": {}}}
        release = {"accepted_main_sha": "abc", "migration_verified": True, "required_ci_passed": True,
                   "administrator_takeover_approved": True, "runtime_argv": ["/node"], "database_identity": {},
                   "runtime_files": [{"path": "server.js", "sha256": "hash"}]}
        with patch.object(o.recovery, "private_file", return_value=Path("receipt")), \
             patch.object(o.recovery, "digest", return_value="hash"), \
             patch.object(o.recovery, "read_json", return_value=release), \
             patch.object(o.recovery, "source", return_value=pg), \
             patch.object(o, "service_cgroup", return_value=Path("/cgroup")), \
             patch.object(o.Path, "resolve", return_value=Path("/release/server.js")), \
             patch.object(o.subprocess, "run", return_value=Mock(returncode=0, stdout="abc")), \
             patch.object(o.subprocess, "Popen", return_value=child), \
             patch.object(o.select, "select", return_value=([connection.stdout], [], [])), \
             patch.object(o, "terminate", side_effect=lambda *args: events.append("terminated")):
            with self.assertRaises(o.recovery.Refusal):
                o.run(plan, ["/node"])
        self.assertLess(events.index("terminated"), events.index("unlocked"))


if __name__ == "__main__":
    unittest.main()
