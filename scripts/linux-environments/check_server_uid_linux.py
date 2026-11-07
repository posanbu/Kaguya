#!/usr/bin/env python3
"""功能概述：在一次性 Linux 容器内以实际不同 UID 验证 broker 的 SO_PEERCRED 授权。
主要职责：启动生产 Server/Broker；子 Python 进程降权后连接同一 socket，验证真实受信 UID
可访问、其他 UID 即使在 JSON 自报受信身份也被拒绝。socket 放宽权限以单独验证内核身份边界。
代码库关系：沿用 test_broker.FakeBackend，不执行 Podman；与 check_bundle_linux 的文件 ACL 验收分开。
输入输出与副作用：只创建临时 socket/journal；要求 Linux 容器内 root 的 SETUID/SETGID 能力，
不得在宿主通过 sudo 执行；子进程和服务线程均有界等待并清理，不创建系统账户。
"""
import json
import os
from pathlib import Path
import platform
import socket
import subprocess
import sys
import tempfile
import threading
import unittest

from broker import Broker
from server import Server
from test_broker import FakeBackend


CLIENT = '''
import json, os, socket, sys
uid = int(sys.argv[1])
os.setgroups([])
os.setgid(uid)
os.setuid(uid)
request = {"protocol": 1, "method": "health", "params": {}}
if len(sys.argv) > 3:
    request["uid"] = int(sys.argv[3])
with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
    connection.settimeout(3)
    connection.connect(sys.argv[2])
    try:
        connection.sendall(json.dumps(request).encode() + b"\\n")
        with connection.makefile("rb") as stream:
            line = stream.readline(65536)
        print(line.decode().strip() if line else "denied")
    except (ConnectionResetError, BrokenPipeError):
        print("denied")
'''


class KernelUidTest(unittest.TestCase):
    def setUp(self):
        if platform.system() != "Linux" or os.geteuid() != 0:
            self.fail("requires root only inside a disposable Linux test container")
        temp = tempfile.TemporaryDirectory(prefix="kg-uid-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.root.chmod(0o711)
        self.backend = FakeBackend()
        self.broker = Broker(self.root / "state", self.backend)
        self.addCleanup(self.broker.close)
        self.path = self.root / "broker.sock"
        self.server = Server(self.path, self.broker, 65534)
        self.addCleanup(self.server.server_close)
        self.path.chmod(0o666)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02})
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.backend.finish.set()
        self.server.stopping = True
        self.server.shutdown()
        self.thread.join(3)
        self.server.stop_reads()
        self.assertTrue(self.server.wait_handlers(4), "UID request handlers did not settle")
        self.assertFalse(self.thread.is_alive(), "UID server did not stop")

    def client(self, uid, reported_uid=None):
        command = [sys.executable, "-I", "-c", CLIENT, str(uid), str(self.path)]
        if reported_uid is not None:
            command.append(str(reported_uid))
        return subprocess.run(command, check=True, timeout=5, capture_output=True, text=True).stdout.strip()

    def test_real_trusted_uid_is_allowed_and_other_uid_cannot_spoof_it(self):
        self.assertTrue(json.loads(self.client(65534))["ok"])
        self.assertEqual(self.client(65533), "denied")
        self.assertEqual(self.client(65533, reported_uid=65534), "denied")
        self.assertEqual(self.client(0, reported_uid=65534), "denied")
        self.assertTrue(json.loads(self.client(65534))["result"]["ready"])
        self.assertEqual(self.backend.effects, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
