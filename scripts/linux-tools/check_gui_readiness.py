"""功能概述：用可控读序列和时钟验证 GUI JSON 就绪条件与总等待预算。
主要职责：覆盖未发布、空/残缺内容、业务条件、损坏内容和超时；不启动 Podman 或真实桌面。
代码库关系：直接调用 gui_fixture_wait 的生产验收等待函数，由 Linux tools workflow 执行。
输入输出与副作用：仅内存 CompletedProcess 与假的时钟；不固定 sleep，不改本机输入或文件。
"""
import subprocess
import unittest
from unittest.mock import patch
import gui_fixture_wait as readiness


class ReadinessTest(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.timeouts = []
        clock = patch.object(readiness.time, "monotonic", lambda: self.now)
        sleep = patch.object(readiness.time, "sleep", self.advance)
        clock.start()
        sleep.start()
        self.addCleanup(clock.stop)
        self.addCleanup(sleep.stop)

    def advance(self, seconds):
        self.now += seconds

    def reader(self, values):
        iterator = iter(values)
        def command(*_parts, check, timeout):
            self.assertFalse(check)
            self.timeouts.append(timeout)
            code, data = next(iterator)
            return subprocess.CompletedProcess([], code, data, b"missing" if code else b"")
        return command

    def test_waits_for_complete_json_and_the_actual_application_condition(self):
        command = self.reader([(1, b""), (0, b""), (0, b'{"count":'),
                               (0, b'{"count":0}'), (0, b'{"count":1}')])
        value = readiness.wait_for_command(command, ["cat", "ledger"],
                                          predicate=lambda value: value["count"] == 1)
        self.assertEqual(value, {"count": 1})
        self.assertEqual(len(self.timeouts), 5)
        self.assertEqual(self.timeouts[0], 15)
        self.assertLess(self.timeouts[-1], 15)

    def test_malformed_json_times_out_with_last_read_instead_of_passing(self):
        def command(*_parts, **options):
            self.timeouts.append(options["timeout"])
            return subprocess.CompletedProcess([], 0, b"{bad", b"")
        with self.assertRaisesRegex(RuntimeError, "decodeError"):
            readiness.wait_for_command(command, ["cat", "ready"], .05, lambda _: True)
        self.assertAlmostEqual(self.now, .05)
        self.assertAlmostEqual(self.timeouts[-1], .01)

    def test_a_slow_read_uses_the_remaining_budget_and_cannot_pass_late(self):
        def command(*_parts, **options):
            self.assertEqual(options["timeout"], 15)
            self.advance(options["timeout"])
            return subprocess.CompletedProcess([], 0, b'{"ready":true}', b"")
        with self.assertRaisesRegex(RuntimeError, "guiReadinessTimeout"):
            readiness.wait_for_command(command, ["cat", "ready"], predicate=lambda _: True)

    def test_transport_and_predicate_errors_are_not_retried(self):
        def broken(*_parts, **_options):
            raise subprocess.TimeoutExpired("podman", 15)
        with self.assertRaises(subprocess.TimeoutExpired):
            readiness.wait_for_command(broken, ["cat", "ready"])
        with self.assertRaises(KeyError):
            readiness.wait_for_command(self.reader([(0, b"{}")]), ["cat", "ready"],
                                       predicate=lambda value: value["required"])

    def test_non_json_readiness_keeps_exit_status_contract(self):
        value = readiness.wait_for_command(self.reader([(1, b""), (0, b"bus-address")]), ["dbus"])
        self.assertEqual(value, b"bus-address")


if __name__ == "__main__":
    unittest.main()
