"""功能概述：只读验证安装策略的纯逻辑边界，所有管理员命令均为受控替身。
主要职责：检查版本锁/来源与拒绝降级、低磁盘仍可回退、固定存储大小和 nftables 范围。
代码库关系：消费生产 bootstrap 函数与 packages.lock.json；不把替身测试算作实际系统安装。
输入输出与副作用：临时目录保存虚构 manifest；从不执行 apt、mount、mkfs、useradd 或 sudo。
"""
import json
import os
from pathlib import Path
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import bootstrap
from broker import BrokerError, verify_storage_mount


class BootstrapTest(unittest.TestCase):
    def test_execution_stack_is_pinned_and_os_dependencies_are_not_held(self):
        source = Path(__file__).parent
        manifest = json.loads((source / "packages.lock.json").read_text())
        pins = manifest["executionPackages"]
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            stdout, code = "", 0
            if args[0] == "dpkg-query":
                name = args[-1]
                stdout = "install ok installed\n" + pins.get(name, manifest["systemCompatibility"].get(name, {}).get("observedPackage", "20260816ubuntu0.26.04.1"))
            elif args[0] == "apt-cache" and "madison" in args:
                stdout = f"{args[-1]} | {pins[args[-1]]} | https://mirrors.ustc.edu.cn/ubuntu resolute/universe amd64 Packages"
            elif args[0] == "dpkg" and args[-2] == "gt":
                code = 1
            return SimpleNamespace(stdout=stdout, returncode=code)
        with patch.object(bootstrap, "run", side_effect=run):
            _, actual = bootstrap.install_packages(source)
        install = next(c for c in calls if c[0] == "apt-get" and "install" in c)
        self.assertEqual(set(install[install.index("--no-install-recommends") + 1:]), {f"{k}={v}" for k, v in pins.items()})
        self.assertIn("Dir::Etc::sourceparts=-", install)
        self.assertTrue(any(arg.startswith("Dir::Etc::sourcelist=/") for arg in install))
        self.assertEqual(actual["podman"], pins["podman"])
        self.assertFalse(any("hold" in c or "--allow-downgrades" in c for c in calls))

    def test_removed_package_version_is_not_an_installed_dependency(self):
        with patch.object(bootstrap, "run", return_value=SimpleNamespace(
                returncode=0, stdout="deinstall ok config-files\n1.2.3")):
            self.assertEqual(bootstrap.installed_package("podman"), "")
        with patch.object(bootstrap, "run", return_value=SimpleNamespace(
                returncode=0, stdout="install ok installed\n1.2.3")):
            self.assertEqual(bootstrap.installed_package("podman"), "1.2.3")

    def test_stale_storage_stage_requires_ownership_and_no_loop_attachment(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        stage = root / "containers.preparing"
        stage.write_bytes(b"interrupted-mkfs")
        stage.chmod(0o600)
        owner = {"serviceUid": 987}
        account = SimpleNamespace(pw_uid=987, pw_gid=987)
        trusted = SimpleNamespace(pw_uid=1000)
        original_lstat = Path.lstat
        def root_stage(path, *args, **kwargs):
            value = original_lstat(path, *args, **kwargs)
            if path != stage:
                return value
            return SimpleNamespace(st_mode=value.st_mode, st_uid=0, st_nlink=1, st_size=value.st_size)
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            if args[0] == "fallocate":
                raise RuntimeError("reached-new-allocation")
            return SimpleNamespace(stdout="", returncode=0)
        with patch.object(bootstrap, "STORAGE", root), patch.object(bootstrap, "safe_path"), \
             patch.object(bootstrap, "installed_identity", return_value=owner), patch.object(Path, "lstat", root_stage), \
             patch.object(bootstrap, "run", side_effect=run):
            with self.assertRaisesRegex(RuntimeError, "reached-new-allocation"):
                bootstrap.provision_storage(account, trusted)
        self.assertFalse(stage.exists())
        self.assertTrue(any(c[0] == "losetup" for c in calls))

    def test_rollback_preflight_does_not_require_free_disk(self):
        user = SimpleNamespace(pw_uid=1000)
        def read(path, *args, **kwargs):
            if str(path) == "/etc/os-release":
                return 'ID=ubuntu\nVERSION_ID="26.04"'
            raise AssertionError(path)
        with patch.object(bootstrap.platform, "system", return_value="Linux"), \
             patch.object(bootstrap.platform, "machine", return_value="x86_64"), \
             patch.object(bootstrap.pwd, "getpwnam", return_value=user), \
             patch.object(Path, "read_text", read), \
             patch.object(Path, "exists", return_value=True), \
             patch.object(Path, "is_symlink", return_value=False), \
             patch.object(bootstrap.shutil, "disk_usage", return_value=SimpleNamespace(free=0)):
            self.assertEqual(bootstrap.preflight("andrew", installing=False), user)
            with self.assertRaisesRegex(RuntimeError, "insufficient-install-capacity"):
                bootstrap.preflight("andrew", installing=True)

    def test_apply_preflight_counts_validated_reclaimable_stage_before_package_work(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        stage = root / "containers.preparing"
        stage.write_bytes(b"interrupted-24GiB-allocation")
        account = SimpleNamespace(pw_uid=987, pw_gid=987, pw_dir=str(bootstrap.STATE), pw_shell="/usr/sbin/nologin")
        trusted = SimpleNamespace(pw_uid=1000)
        original_read, original_exists = Path.read_text, Path.exists
        def read(path, *args, **kwargs):
            return 'ID=ubuntu\nVERSION_ID="26.04"' if str(path) == "/etc/os-release" else original_read(path, *args, **kwargs)
        def exists(path):
            return True if str(path) == "/sys/fs/cgroup/cgroup.controllers" else original_exists(path)
        with patch.object(bootstrap, "STORAGE", root), patch.object(bootstrap.platform, "system", return_value="Linux"), \
             patch.object(bootstrap.platform, "machine", return_value="x86_64"), patch.object(Path, "read_text", read), \
             patch.object(Path, "exists", exists), patch.object(bootstrap.os, "geteuid", return_value=0), \
             patch.object(bootstrap.pwd, "getpwnam", side_effect=lambda n: account if n == bootstrap.ACCOUNT else trusted), \
             patch.object(bootstrap.grp, "getgrall", return_value=[]), \
             patch.object(bootstrap.shutil, "disk_usage", return_value=SimpleNamespace(free=9 * 1024 ** 3)), \
             patch.object(bootstrap, "validated_staging", return_value=SimpleNamespace(st_blocks=24 * 1024 ** 3 // 512)) as validate, \
             patch.object(bootstrap, "installed_identity", return_value={"trustedUid": 1000, "serviceUid": 987}), \
             patch.object(bootstrap, "run", return_value=SimpleNamespace(returncode=1, stdout="")), \
             patch.object(bootstrap, "install_packages", side_effect=RuntimeError("reached-package-phase")):
            # 真实 apply -> preflight 顺序：剩余 9 GiB + 可回收 24 GiB 足够恢复 28 GiB + 4 GiB。
            with self.assertRaisesRegex(RuntimeError, "reached-package-phase"):
                bootstrap.apply("andrew")
            validate.assert_called_once_with(stage, 24, 987)
            self.assertEqual(stage.read_bytes(), b"interrupted-24GiB-allocation")

    def test_network_policy_is_uid_scoped_and_rejects_host_and_special_addresses(self):
        rules = bootstrap.firewall(987)
        for entry in ("meta skuid 987", "fib daddr type local reject", "100.64.0.0/10", "::ffff:0:0/96", "fc00::/7"):
            self.assertIn(entry, rules)
        self.assertNotIn("flush ruleset", rules)
        self.assertIn("tcp dport { 80, 443 } accept", rules)

    def test_empty_config_and_owned_partial_stage_can_be_resumed(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        config = Path(temp.name)
        with patch.object(bootstrap, "CONFIG", config), patch.object(bootstrap, "safe_path"):
            self.assertIsNone(bootstrap.installed_identity())
            partial = {"installation": "kaguya-linux-environments-v1", "trustedUid": 1000,
                       "serviceUid": 987, "phase": "account-ready"}
            (config / "install-state.json").write_text(json.dumps(partial))
            self.assertEqual(bootstrap.installed_identity(), partial)
            (config / "install-state.json").unlink()
            (config / "unrelated").write_text("preserve")
            with self.assertRaisesRegex(RuntimeError, "unrecognized-partial-installation"):
                bootstrap.installed_identity()

    def test_mount_requires_ext4_and_exact_backing_image(self):
        target = "/var/lib/kaguya-tools-storage/state"
        image = target + ".img"
        backing = image
        filesystem = "ext4"
        def read(path, *args, **kwargs):
            if str(path) == "/proc/self/mountinfo":
                return f"1 0 7:3 / {target} rw - {filesystem} /dev/loop3 rw\n"
            if str(path) == "/sys/dev/block/7:3/loop/backing_file":
                return backing
            raise AssertionError(path)
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_uid=0, st_blocks=8192, st_size=4194304)
        with patch.object(Path, "read_text", read), patch.object(Path, "is_symlink", return_value=False), \
             patch.object(Path, "stat", return_value=info):
            verify_storage_mount(target, image)
            backing = "/var/lib/someone-elses-data.img"
            with self.assertRaisesRegex(BrokerError, "storage-backing-file-mismatch"):
                verify_storage_mount(target, image)
            backing = image
            filesystem = "xfs"
            with self.assertRaisesRegex(BrokerError, "unexpected-storage-filesystem"):
                verify_storage_mount(target, image)
            filesystem = "ext4"
            info.st_blocks = 0
            with self.assertRaisesRegex(BrokerError, "storage-reservation-invalid"):
                verify_storage_mount(target, image)

    def test_sparse_storage_is_rejected_before_publish_and_mkfs_uses_nodiscard(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name) / "storage"
        calls = []
        def run(*args, **kwargs):
            calls.append(args)
            if args[0] == "fallocate":
                # 替身模拟保留字节数但缺少真实 block 的失败，绝不分配 24 GiB。
                os.truncate(args[-1], int(args[2]))
            return SimpleNamespace(stdout="", returncode=0)
        with patch.object(bootstrap, "STORAGE", root), patch.object(bootstrap, "safe_path"), \
             patch.object(bootstrap, "run", side_effect=run):
            with self.assertRaisesRegex(RuntimeError, "storage-reservation-lost"):
                bootstrap.provision_storage(SimpleNamespace(pw_uid=987, pw_gid=987), SimpleNamespace(pw_uid=1000))
        mkfs = next(c for c in calls if c[0] == "mkfs.ext4")
        self.assertIn("nodiscard,lazy_itable_init=0,lazy_journal_init=0", mkfs)
        self.assertFalse((root / "containers.img").exists())
        self.assertFalse((root / "containers.preparing").exists())


if __name__ == "__main__":
    unittest.main()
