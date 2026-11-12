"""功能概述：注入 GUI 验收诊断失败，验证完整 finally 继续回收容器和探针。
主要职责：CleanupTest 编译 check-gui-container.py 的实际 finally，在主错误下模拟诊断与清理故障。
代码库关系：Linux tools workflow 执行；直接读取验收源码，避免复制清理实现或启动真实 Podman。
输入输出与副作用：仅内存命令、文件与进程替身；验证原错误身份、错误聚合、rm 与 kill/wait 的实际调用。
"""
import ast
from pathlib import Path
import subprocess
import sys
import traceback
import unittest
from unittest.mock import Mock


class CleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        source = Path(__file__).with_name("check-gui-container.py")
        tree = ast.parse(source.read_text(), filename=str(source))
        finalizers = [node.finalbody for node in tree.body
                      if isinstance(node, ast.Try) and node.finalbody]
        if len(finalizers) != 1:
            raise AssertionError("expected one top-level GUI resource finalizer")
        # 使用实际 finally；替换主流程为一次确定失败，不执行顶层 CLI、镜像加载或真实输入。
        injected = ast.parse("try:\n    raise primary_error\nfinally:\n    pass\n")
        injected.body[0].finalbody = finalizers[0]
        cls.cleanup = compile(ast.fix_missing_locations(injected), str(source), "exec")

    def run_failure(self, *, write_error=None, print_error=None, remove_error=None):
        primary = RuntimeError("original GUI operation failed")
        path = Mock()
        path.return_value.write_text.side_effect = write_error
        printer = Mock(side_effect=print_error)
        probe = Mock()
        probe.poll.return_value = None

        def respond(*parts, **_options):
            if parts[0] == "rm" and remove_error is not None:
                raise remove_error
            return subprocess.CompletedProcess(parts, 0, b"{}", b"")

        command = Mock(side_effect=respond)
        scope = {"primary_error": primary, "sys": sys, "traceback": traceback,
                 "Path": path, "print": printer, "command": command,
                 "name": "fixture-container", "podman_unresponsive": False,
                 "probe_process": probe}
        with self.assertRaises(BaseException) as caught:
            exec(self.cleanup, scope)
        command.assert_any_call("rm", "--force", "--ignore", "fixture-container")
        probe.kill.assert_called_once_with()
        probe.wait.assert_called_once_with(timeout=5)
        return primary, caught.exception, path

    def test_failure_file_write_cannot_skip_resource_cleanup(self):
        for error in (OSError(28, "No space left on device"),
                      OSError(30, "Read-only file system")):
            with self.subTest(errno=error.errno):
                primary, result, path = self.run_failure(write_error=error)
                self.assertIsInstance(result, BaseExceptionGroup)
                self.assertEqual(result.exceptions, (primary, error))
                path.return_value.write_text.assert_called_once()

    def test_stderr_failure_cannot_skip_resource_cleanup(self):
        error = BrokenPipeError("diagnostic stream closed")
        primary, result, _ = self.run_failure(print_error=error)
        self.assertIsInstance(result, BaseExceptionGroup)
        self.assertIs(result.exceptions[0], primary)
        self.assertIn(error, result.exceptions)

    def test_diagnostic_and_container_failure_still_reap_probe(self):
        diagnostic = OSError(28, "No space left on device")
        removal = RuntimeError("container removal failed")
        primary, result, _ = self.run_failure(write_error=diagnostic, remove_error=removal)
        self.assertIsInstance(result, BaseExceptionGroup)
        self.assertEqual(result.exceptions, (primary, diagnostic, removal))

    def test_successful_cleanup_preserves_original_error_object(self):
        primary, result, _ = self.run_failure()
        self.assertIs(result, primary)


if __name__ == "__main__":
    unittest.main()
