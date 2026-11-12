"""功能概述：在目录句柄已打开后用 barrier 替换父目录，证明不会跟随新 symlink 泄漏私有文件。
主要职责：直接调用生产 open_beneath；hook 仅为测试调用，不暴露给 helper 的请求或命令行。
输入输出与副作用：独立临时目录/文件，确定性替换时序，无固定 sleep。
"""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("files", Path(__file__).with_name("file-access.py"))
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class FileTest(unittest.TestCase):
    def test_parent_replaced_after_directory_open_stays_on_original_inode(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "public").mkdir()
            (root / "private").mkdir()
            (root / "public/value").write_bytes(b"allowed")
            (root / "private/value").write_bytes(b"secret")
            def swap():
                (root / "public").rename(root / "old")
                (root / "public").symlink_to(root / "private", target_is_directory=True)
            fd = files.open_beneath(str(root), "public/value", swap)
            with os.fdopen(fd, "rb") as source:
                self.assertEqual(source.read(), b"allowed")
            with self.assertRaises(OSError):
                files.open_beneath(str(root), "public/value")


if __name__ == "__main__":
    unittest.main()
