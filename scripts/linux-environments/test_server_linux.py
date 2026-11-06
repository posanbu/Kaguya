"""功能概述：Linux 原生 Unix socket/内核 SO_PEERCRED 的真实入口验收，无 root 或 Podman。
主要职责：覆盖受信/非受信 UID、伪造 UID、畸形/超限请求、并发上限、连接丢失后核对和关闭；
经真实 RPC 验证租约过期、接管/恢复与持久重启后的旧输入拒绝，时钟由 fixture 控制。
代码库关系：启动生产 Server 与 Broker，执行端使用有界受控 FakeBackend；Linux CI 独立运行。
输入输出与副作用：临时 socket；全部连接和线程立即登记清理，条件变量等待而非固定 sleep。
"""
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest
from broker import Broker
from server import Server, peer_uid
from test_broker import FakeBackend


class ServerTest(unittest.TestCase):
    def setUp(self):
        if not hasattr(socket, "SO_PEERCRED"):
            self.fail("This suite requires real Linux SO_PEERCRED; run it in the Linux CI job")
        self.temp = tempfile.TemporaryDirectory(prefix="kg-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = FakeBackend()
        self.now = time.time()
        self.broker = Broker(self.root / "state", self.backend, clock=lambda: self.now)
        self.addCleanup(lambda: self.broker.close())
        self.path = self.root / "broker.sock"
        self.server = Server(self.path, self.broker, os.getuid())
        self.addCleanup(self.server.server_close)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02})
        self.thread.start()
        def stop():
            self.backend.finish.set()
            self.server.stopping = True
            self.server.shutdown()
            self.thread.join(3)
            self.server.stop_reads()
            self.assertTrue(self.server.wait_handlers(4), "request handlers did not settle")
            self.assertFalse(self.thread.is_alive())
        self.addCleanup(stop)

    def connect(self):
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(client.close)
        client.settimeout(3)
        client.connect(str(self.path))
        return client

    def rpc(self, method="health", params=None, raw=None):
        client = self.connect()
        client.sendall(raw if raw is not None else json.dumps({"protocol": 1, "method": method, "params": params or {}}).encode() + b"\n")
        stream = client.makefile("rb")
        self.addCleanup(stream.close)
        return json.loads(stream.readline())

    def bound_environment(self):
        created = self.rpc("environment.create", {
            "environmentId": "env", "scope": "scope", "workspaceId": "ws",
            "resourceIds": ["desktop"], "image": "example.org/tools@sha256:" + "1" * 64,
        })
        self.assertTrue(created["ok"])
        return self.rpc("lease.acquire", {
            "environmentId": "env", "scope": "scope", "workflowId": "flow", "ttlSeconds": 60,
        })["result"]

    def operation(self, binding, name="op"):
        return {**binding, "scope": "scope", "intentId": "intent", "attemptId": "attempt",
                "operationId": name, "digest": "digest", "toolName": "shell.exec",
                "arguments": {}, "target": {}, "deadline": "2099-01-01T00:00:00Z"}

    def control(self, generation, name="control"):
        return {"environmentId": "env", "scope": "scope", "generation": generation,
                "controlAuthorizationId": name}

    def test_rpc_scope_expiry_and_explicit_recovery_fence_old_requests(self):
        binding = self.bound_environment()
        original = self.operation(binding)
        self.assertFalse(self.rpc("lease.validate", {**binding, "scope": "other"})["ok"])
        self.assertFalse(self.rpc("operation.execute", {**original, "scope": "other"})["ok"])
        self.now += 61
        self.assertFalse(self.rpc("operation.execute", original)["ok"])
        self.assertFalse(self.rpc("lease.renew", {**binding, "scope": "scope"})["ok"])
        self.assertFalse(self.rpc("lease.acquire", {
            "environmentId": "env", "scope": "scope", "workflowId": "other",
        })["ok"])
        self.assertEqual(self.backend.effects, 0)
        restored = self.rpc("environment.recover", self.control(0))["result"]
        self.assertEqual((restored["state"], restored["generation"]), ("ready", 1))
        replacement = self.rpc("lease.acquire", {
            "environmentId": "env", "scope": "scope", "workflowId": "new",
        })["result"]
        self.assertGreater(int(replacement["environment"]["fencing"]), int(binding["environment"]["fencing"]))
        self.assertFalse(self.rpc("operation.execute", original)["ok"])
        self.assertFalse(self.rpc("lease.release", {**binding, "scope": "scope"})["ok"])
        self.assertEqual(self.rpc("operation.execute", self.operation(replacement, "new-op"))["result"]["status"], "succeeded")
        self.assertEqual(self.backend.effects, 1)

    def test_rpc_handoff_and_resume_require_new_lease_preserving_desktop(self):
        binding = self.bound_environment()
        desktop = set(self.backend.running)
        handoff = self.rpc("environment.handoff", self.control(0))["result"]
        self.assertEqual((handoff["state"], handoff["generation"]), ("human", 1))
        self.assertEqual(self.rpc("environment.handoff", self.control(0))["result"], handoff)
        self.assertEqual(self.backend.running, desktop)
        self.assertFalse(self.rpc("operation.execute", self.operation(binding))["ok"])
        self.assertFalse(self.rpc("lease.acquire", {
            "environmentId": "env", "scope": "scope", "workflowId": "flow",
        })["ok"])
        self.assertEqual(self.backend.effects, 0)
        resumed = self.rpc("environment.resume", self.control(1, "resume"))["result"]
        self.assertEqual((resumed["state"], resumed["generation"]), ("ready", 2))
        self.assertEqual(self.backend.running, desktop)
        self.assertEqual(len(self.backend.handoffs), 2)
        replacement = self.rpc("lease.acquire", {
            "environmentId": "env", "scope": "scope", "workflowId": "flow",
        })["result"]
        self.assertFalse(self.rpc("operation.execute", self.operation(binding))["ok"])
        self.assertEqual(self.rpc("operation.execute", self.operation(replacement, "new"))["result"]["status"], "succeeded")
        self.assertEqual(self.backend.effects, 1)

    def test_rpc_restart_retains_unknown_and_does_not_replay(self):
        binding = self.bound_environment()
        original = self.operation(binding)
        self.backend.fail_after_effect = True
        first = self.rpc("operation.execute", original)["result"]
        self.assertEqual(first["status"], "unknown")
        self.assertTrue(self.server.wait_handlers(4), "handlers must settle before replacing broker")
        self.broker.close()
        self.broker = Broker(self.root / "state", self.backend, clock=lambda: self.now)
        self.server.broker = self.broker
        self.assertEqual(self.rpc("environment.inspect", {"environmentId": "env", "scope": "scope"})["result"]["state"], "quarantined")
        self.assertFalse(self.rpc("operation.execute", original)["ok"])
        self.assertTrue(self.rpc("environment.recover", self.control(0))["ok"])
        replacement = self.rpc("lease.acquire", {
            "environmentId": "env", "scope": "scope", "workflowId": "new",
        })["result"]
        reconciled = self.rpc("operation.reconcile", {
            **original, "controlEnvironment": replacement["environment"],
            "token": replacement["token"], "controlAuthorizationId": "reconcile",
        })["result"]
        self.assertEqual(reconciled, first)
        self.assertEqual(self.backend.effects, 1)

    def test_real_peer_uid_and_health(self):
        left, right = socket.socketpair()
        self.addCleanup(left.close)
        self.addCleanup(right.close)
        self.assertEqual(peer_uid(left), os.getuid())
        self.assertEqual(self.rpc()["result"]["environments"], 0)

    def test_other_uid_and_self_reported_uid_do_not_authorize(self):
        self.server.trusted_uid = os.getuid() + 1
        client = self.connect()
        client.sendall(b'{"protocol":1,"method":"health","params":{},"uid":0}\n')
        try:
            self.assertEqual(client.recv(100), b"")
        except ConnectionResetError:
            pass
        self.server.trusted_uid = os.getuid()
        response = self.rpc(raw=b'{"protocol":1,"method":"health","params":{},"uid":0}\n')
        self.assertFalse(response["ok"])

    def test_request_boundary_and_duplicate_keys(self):
        for raw in (b'{}\n', b'{"protocol":1,"method":"health","method":"other","params":{}}\n',
                    b'{"protocol":1,"method":"health","params":{"n":NaN}}\n', b'x' * 262145 + b'\n'):
            with self.subTest(size=len(raw)):
                self.assertFalse(self.rpc(raw=raw)["ok"])
        self.assertFalse(self.rpc(method="podman.run", params={"argv": ["--privileged"]})["ok"])

    def test_sixteen_connections_bound_workers(self):
        condition = threading.Condition()
        entered = 0
        original = self.server.process_request_thread
        def tracked(request, address):
            nonlocal entered
            with condition:
                entered += 1
                condition.notify_all()
            original(request, address)
        self.server.process_request_thread = tracked
        for i in range(16):
            self.connect()
            with condition:
                self.assertTrue(condition.wait_for(lambda: entered == i + 1, timeout=3))
        with condition:
            self.assertTrue(condition.wait_for(lambda: entered == 16, timeout=3))
        refused = self.connect()
        self.assertEqual(refused.recv(1), b"")
        self.assertEqual(entered, 16)

    def test_effect_receipt_survives_dropped_response(self):
        self.rpc("environment.create", {"environmentId": "env", "scope": "scope", "workspaceId": "ws",
                  "resourceIds": ["desktop"], "image": "example.org/tools@sha256:" + "1" * 64})
        binding = self.rpc("lease.acquire", {"environmentId": "env", "scope": "scope", "workflowId": "flow"})["result"]
        request = {"environment": binding["environment"], "token": binding["token"], "scope": "scope",
                   "intentId": "intent", "attemptId": "attempt", "operationId": "op", "digest": "digest",
                   "toolName": "shell.exec", "arguments": {}, "target": {}, "deadline": "2099-01-01T00:00:00Z"}
        persisted = threading.Event()
        original = self.broker._save_op
        def save(key, op):
            original(key, op)
            if op.get("phase") == "returned":
                persisted.set()
        self.broker._save_op = save
        client = self.connect()
        client.sendall(json.dumps({"protocol": 1, "method": "operation.execute", "params": request}).encode() + b"\n")
        client.close()
        self.assertTrue(persisted.wait(3))
        result = self.rpc("operation.reconcile", {**request, "controlEnvironment": binding["environment"],
                          "controlAuthorizationId": "control"})["result"]
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(self.backend.effects, 1)

    def test_shutdown_with_inflight_collect_isolates_then_settles_real_socket_handler(self):
        self.rpc("environment.create", {"environmentId": "env", "scope": "scope", "workspaceId": "ws",
                  "resourceIds": ["desktop"], "image": "example.org/tools@sha256:" + "1" * 64})
        binding = self.rpc("lease.acquire", {"environmentId": "env", "scope": "scope", "workflowId": "flow"})["result"]
        self.backend.finish.clear()
        # 隔离确认与回执到达保持独立屏障，证明 close 后不能写入已释放的 journal。
        self.backend.isolate = lambda env: self.backend.running.discard(env["container"])
        request = {**binding, "scope": "scope", "intentId": "intent", "attemptId": "attempt",
                   "operationId": "op", "digest": "digest", "toolName": "shell.exec", "arguments": {},
                   "target": {}, "deadline": "2099-01-01T00:00:00Z"}
        client = self.connect()
        client.sendall(json.dumps({"protocol": 1, "method": "operation.execute", "params": request}).encode() + b"\n")
        self.assertTrue(self.backend.entered.wait(3))
        self.server.stopping = True
        self.server.shutdown()
        self.thread.join(3)
        self.server.server_close()
        self.server.stop_reads()
        self.broker.close()
        self.assertFalse(self.backend.running)
        snapshot = {p.name: p.read_bytes() for p in self.broker.journal.path.glob("*.json")}
        self.backend.finish.set()
        self.assertTrue(self.server.wait_handlers(4))
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in self.broker.journal.path.glob("*.json")})
        self.assertEqual(self.backend.effects, 1)
        stream = client.makefile("rb")
        self.addCleanup(stream.close)
        self.assertEqual(json.loads(stream.readline())["result"]["status"], "unknown")


if __name__ == "__main__":
    unittest.main()
