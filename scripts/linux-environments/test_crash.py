"""功能概述：通过 SIGKILL 而非正常 close 验证生产文件日志恢复边界。
主要职责：等待 child 的持久 dispatched 屏障，杀死后重开 broker，用新 lease 读取旧 attempt。
代码库关系：crash_fixture.py 提供受控效果；本测试不依赖真实 Podman 或外部网站。
输入输出与副作用：临时目录/子进程取得后立即注册清理，所有等待均有 5 秒上限。
"""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys
import tempfile
import time
import unittest
from broker import Broker, BrokerError
from test_broker import FakeBackend


class CrashTest(unittest.TestCase):
    def test_dispatched_process_crash_retains_unknown_and_never_repeats_effect(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        child = subprocess.Popen([sys.executable, "-B", str(Path(__file__).with_name("crash_fixture.py")), str(root)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        def cleanup():
            if child.poll() is None:
                child.kill()
            try:
                child.wait(timeout=5)
            finally:
                for stream in (child.stdin, child.stdout, child.stderr):
                    stream.close()
        self.addCleanup(cleanup)
        selector = selectors.DefaultSelector()
        self.addCleanup(selector.close)
        selector.register(child.stdout, selectors.EVENT_READ)
        deadline = time.monotonic() + 5
        message = bytearray()
        os.set_blocking(child.stdout.fileno(), False)
        while b"\n" not in message:
            remaining = deadline - time.monotonic()
            self.assertGreater(remaining, 0, "child did not finish durable dispatch message")
            self.assertTrue(selector.select(remaining), "child did not reach durable dispatch")
            chunk = os.read(child.stdout.fileno(), 4096)
            self.assertTrue(chunk, f"child exited before dispatch message: {child.poll()}")
            message.extend(chunk)
            self.assertLessEqual(len(message), 262144)
        request = json.loads(message)
        self.assertEqual((root / "effect-count").read_text(), "1")
        child.kill()
        child.wait(timeout=5)
        old_records = {p.name: p.read_bytes() for p in (root / "journal").glob("*.json")}
        backend = FakeBackend()
        broker = Broker(root, backend)
        self.addCleanup(broker.close)
        self.assertEqual(broker.environments["env"]["state"], "quarantined")
        broker.takeover({"environmentId": "env", "scope": "scope", "generation": 0, "controlAuthorizationId": "control"})
        binding = broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "recovery", "ttlSeconds": 60})
        control = {**request, "controlEnvironment": binding["environment"], "token": binding["token"],
                   "controlAuthorizationId": "control"}
        self.assertEqual(broker.reconcile(control)["status"], "unknown")
        with self.assertRaises(BrokerError):
            broker.execute(request)
        self.assertEqual(backend.effects, 0)
        self.assertEqual((root / "effect-count").read_text(), "1")
        for name, data in old_records.items():
            self.assertEqual((root / "journal" / name).read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
