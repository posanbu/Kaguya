#!/usr/bin/env python3
"""功能概述：仅在临时 Linux CI 中以 root 启动，fork 三个实际 UID 验证安装归档的 inode ACL。
主要职责：确认 owner/broker 可读、第三 UID 不可读、同 hash 重入，以及 broker 替换路径时不授权其他文件。
代码库关系：直接调用生产 install_bundle.stage_image/acl_set_fd；工作目录全在临时目录，不创建账户或服务。
输入输出与副作用：只在子进程降低 UID/GID，不执行 sudo/Podman/安装；父进程有界等待并清理测试文件。
"""
import hashlib
import json
import os
from pathlib import Path
import platform
import select
import signal
import tempfile
import unittest
from unittest.mock import patch
import install_bundle as bundle


def read_ready(fd):
    if not select.select([fd], [], [], 8)[0]:
        raise RuntimeError("cross-uid-child-timeout")
    return os.read(fd, 65536)


def as_uid(uid, operation, interleave=None):
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            os.setgroups([])
            os.setgid(uid)
            os.setuid(uid)
            result = {"ok": True, "value": operation()}
        except BaseException as error:
            result = {"ok": False, "error": type(error).__name__, "reason": str(error)}
        os.write(write_fd, json.dumps(result).encode())
        os._exit(0)
    os.close(write_fd)
    try:
        if interleave:
            interleave()
        return json.loads(read_ready(read_fd))
    finally:
        os.close(read_fd)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)


class BundleLinuxTest(unittest.TestCase):
    def setUp(self):
        if platform.system() != "Linux" or os.geteuid() != 0:
            self.fail("requires root in ephemeral Linux CI for real cross-UID checks")
        self.owner = int(os.environ.get("SUDO_UID", "1000")) or 1000
        self.broker, self.other = 65534, 65533
        self.assertEqual(len({self.owner, self.broker, self.other}), 3)
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.root.chmod(0o711)
        self.source = self.root / "source"
        self.source.mkdir(mode=0o700)
        os.chown(self.source, self.owner, self.owner)
        data = b"synthetic actual inode permission check"
        path = self.source / "image.oci"
        path.write_bytes(data)
        path.chmod(0o600)
        os.chown(path, self.owner, self.owner)
        self.image = {"file": path.name, "archiveSha256": hashlib.sha256(data).hexdigest()}
        self.inbox = self.root / "inbox"
        self.inbox.mkdir(mode=0o733)
        self.inbox.chmod(0o733)
        os.chown(self.inbox, self.broker, self.broker)
        self.target = self.inbox / (self.image["archiveSha256"] + ".oci")

    def stage(self):
        bundle.stage_image(self.source, self.image, self.inbox, self.broker)

    def test_real_broker_reads_owner_archive_but_other_uid_cannot_and_reentry_retains_inode(self):
        self.assertTrue(as_uid(self.owner, self.stage)["ok"])
        inode = self.target.stat().st_ino
        self.assertTrue(as_uid(self.broker, lambda: self.target.read_text())["ok"])
        self.assertEqual(as_uid(self.other, lambda: self.target.read_text())["error"], "PermissionError")
        self.assertTrue(as_uid(self.owner, self.stage)["ok"])
        self.assertEqual(self.target.stat().st_ino, inode)
        self.assertTrue(as_uid(self.broker, lambda: self.target.read_text())["ok"])

    def test_other_uid_replaces_checked_path_before_acl_without_granting_victim_access(self):
        self.assertTrue(as_uid(self.owner, self.stage)["ok"])
        victim = self.root / "victim"
        victim.write_text("unrelated private file")
        victim.chmod(0o600)
        os.chown(victim, self.owner, self.owner)
        ready_read, ready_write = os.pipe()
        resume_read, resume_write = os.pipe()
        original_acl = bundle.set_broker_read_acl
        def checked_then_replaced(fd, broker_uid):
            os.write(ready_write, b"ready")
            read_ready(resume_read)
            original_acl(fd, broker_uid)
        def attempt():
            with patch.object(bundle, "set_broker_read_acl", side_effect=checked_then_replaced):
                self.stage()
        def replace():
            self.target.unlink()
            self.target.symlink_to(victim)
        def interleave():
            self.assertEqual(read_ready(ready_read), b"ready")
            self.assertTrue(as_uid(self.broker, replace)["ok"])
            os.write(resume_write, b"continue")
        try:
            result = as_uid(self.owner, attempt, interleave)
        finally:
            for fd in (ready_read, ready_write, resume_read, resume_write):
                os.close(fd)
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "inbox-path-replaced")
        self.assertEqual(as_uid(self.broker, lambda: victim.read_text())["error"], "PermissionError")
        self.assertEqual(victim.stat().st_mode & 0o777, 0o600)
        self.assertFalse(as_uid(self.owner, self.stage)["ok"])
        self.assertEqual(as_uid(self.broker, lambda: victim.read_text())["error"], "PermissionError")


if __name__ == "__main__":
    unittest.main(verbosity=2)
