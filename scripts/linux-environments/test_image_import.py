"""功能概述：验证 broker 对 inbox 镜像文件类型与摘要的导入边界。
主要职责：以临时 FIFO、普通文件和符号链接核对入口拒绝行为及正常导入。
代码库关系：调用 broker.PodmanBackend.import_image；替换存储挂载检查和 Podman 命令。
输入输出与副作用：仅写临时目录，不启动容器、访问系统服务或执行特权命令。
"""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import broker


class ImageImportTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'containers'
        (self.root / 'inbox').mkdir(parents=True)
        self.backend = broker.PodmanBackend()
        self.backend.command = unittest.mock.Mock(return_value=b'')
        self.sha = hashlib.sha256(b'archive').hexdigest()
        self.source = self.root / 'inbox' / (self.sha + '.oci')

    def perform(self):
        original_path = Path
        def path(value):
            if value == '/var/lib/kaguya-tools-storage/containers':
                return self.root
            return original_path(value)
        original_open = os.open
        def guarded_open(file, flags, *args, **kwargs):
            if file == self.source:
                self.assertTrue(flags & os.O_NONBLOCK, 'inbox open must not block before type check')
            return original_open(file, flags, *args, **kwargs)
        with patch.object(broker, 'Path', side_effect=path), \
             patch.object(broker, 'verify_storage_mount'), \
             patch.object(broker.os, 'open', side_effect=guarded_open):
            return self.backend.import_image(self.sha)

    def test_fifo_rejected_without_waiting_for_writer(self):
        os.mkfifo(self.source)
        with self.assertRaisesRegex(broker.BrokerError, 'invalid-image-archive'):
            self.perform()
        self.backend.command.assert_not_called()

    def test_regular_archive_import_and_tampering(self):
        self.source.write_bytes(b'archive')
        self.assertEqual(self.perform(), {'imported': True, 'archiveSha256': self.sha})
        self.assertEqual(self.backend.command.call_count, 1)
        self.source.write_bytes(b'changed')
        with self.assertRaisesRegex(broker.BrokerError, 'image-checksum-mismatch'):
            self.perform()
        self.assertEqual(self.backend.command.call_count, 1)
        self.assertEqual(list((self.root / 'imports').iterdir()), [])

    def test_symlink_is_not_followed(self):
        victim = self.root / 'victim'
        victim.write_bytes(b'archive')
        self.source.symlink_to(victim)
        with self.assertRaises(OSError):
            self.perform()
        self.backend.command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
