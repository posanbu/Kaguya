"""功能概述：用受控执行后端验证持久环境协议，不冒充真实 Podman/GUI 验收。
主要职责：测试取消先到、去重、接管物理屏障、租约隔离、崩溃恢复及秘密/产物边界。
代码库关系：直接消费生产 Broker；FakeBackend 的事件提供明确开始和完成屏障。
输入输出与副作用：每例独立临时 journal，线程使用有界 Event 等待并在 tearDown 释放。
"""
import base64
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from broker import Broker, BrokerError, PodmanBackend, chromium_profile, CHROMIUM_POLICIES


class FakeBackend:
    def __init__(self):
        self.effects = 0
        self.running = set()
        self.entered = threading.Event()
        self.finish = threading.Event()
        self.finish.set()
        self.fail_stop = False
        self.fail_after_effect = False
        self.requests = []
        self.isolated = threading.Event()
        self.timeouts = []
        self.handoffs = []

    def discard(self, handle):
        pass

    def handoff(self, env, generation, mode):
        self.handoffs.append((env["container"], generation, mode))
        return {"helperProtocolVersion": 1, "generation": generation, "mode": mode,
                "automationIsolated": True, "humanInputsIsolated": True,
                "humanSessionId": (env.get("pendingHuman") or {}).get("id")}

    def create(self, env):
        self.running.add(env["container"])

    def isolate(self, env):
        if self.fail_stop:
            raise BrokerError("isolation-unconfirmed")
        self.running.discard(env["container"])
        self.isolated.set()
        self.finish.set()

    def launch(self, env, request):
        if env["container"] not in self.running:
            raise BrokerError("not-running")
        self.effects += 1
        self.requests.append(request)
        self.entered.set()
        return request

    def collect(self, handle, timeout):
        self.timeouts.append(timeout)
        if not self.finish.wait(3):
            raise AssertionError("test-release-not-observed")
        if self.fail_after_effect:
            raise BrokerError("transport-lost")
        return {"status": "succeeded", "evidence": "returned", "result": {"count": self.effects},
                "artifacts": [{"mime": "text/plain", "dataBase64": base64.b64encode(b"receipt").decode()}]}


class BrokerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.backend = FakeBackend()
        self.now = 1000.0
        self.broker = Broker(self.root, self.backend, clock=lambda: self.now)
        self.addCleanup(lambda: self.broker.close())
        self.threads = []
        self.addCleanup(self.cleanup_workers)
        self.env = self.broker.create({"environmentId": "env", "scope": "scope", "workspaceId": "ws",
                    "resourceIds": ["browser", "desktop"], "image": "example.org/tools@sha256:" + "1" * 64,
                    "network": "none"})
        self.binding = self.broker.acquire({"environmentId": "env", "scope": "scope",
                                           "workflowId": "flow", "ttlSeconds": 60})

    def cleanup_workers(self):
        self.backend.finish.set()
        failures = []
        for t in self.threads:
            t.join(4)
            if t.is_alive():
                failures.append(t.name)
        self.assertEqual(failures, [], "workers did not stop")

    def request(self, operation="op", binding=None):
        b = binding or self.binding
        return {"environment": b["environment"], "token": b["token"], "scope": "scope",
                "intentId": "intent", "attemptId": "attempt", "operationId": operation,
                "digest": "d" * 64, "toolName": "shell.exec", "arguments": {"command": "true"},
                "target": {}, "deadline": "2099-01-01T00:00:00Z"}

    def control(self, request, binding=None):
        b = binding or self.binding
        return {**request, "controlEnvironment": b["environment"], "token": b["token"],
                "controlAuthorizationId": "control"}

    def takeover(self):
        return self.broker.takeover({"environmentId": "env", "scope": "scope", "generation": 0,
                                    "controlAuthorizationId": "human"})

    def test_preserved_desktop_pending_generation_recovers_each_crash_window(self):
        class Crash(BaseException):
            pass
        for after in (False, True):
            with self.subTest(after_helper=after):
                actual = [0]
                def isolate(env):
                    self.assertIn(actual[0], (env["generation"], env.get("pendingControl", {}).get("generation")))
                    return {"generation": actual[0]}
                def recover(old, new):
                    self.assertEqual(old["generation"], actual[0])
                    if after:
                        actual[0] = new["generation"]
                    raise Crash()
                backend = FakeBackend()
                backend.isolate, backend.recover_existing = isolate, recover
                with tempfile.TemporaryDirectory() as root:
                    broker = Broker(root, backend)
                    try:
                        broker.create({"environmentId": "transition", "scope": "scope", "workspaceId": "transition",
                                       "resourceIds": ["screen"], "image": "example.org/tools@sha256:" + "1" * 64})
                        with self.assertRaises(Crash):
                            broker.takeover({"environmentId": "transition", "scope": "scope", "generation": 0,
                                             "controlAuthorizationId": "recover"})
                        pending = broker.environments["transition"]
                        self.assertEqual(pending["generation"], 0)
                        self.assertEqual(pending["pendingControl"]["generation"], 1)
                    finally:
                        broker.journal.close()  # 模拟崩溃，不调用正常 close 隔离。
                    broker = Broker(root, backend)
                    try:
                        env = broker.environments["transition"]
                        self.assertEqual(env["generation"], int(after))
                        self.assertEqual(env["state"], "quarantined")
                        self.assertNotIn("pendingControl", env)
                        self.assertIsNone(env["lease"])
                        def recovered(old, new):
                            self.assertEqual(old["generation"], actual[0])
                            actual[0] = new["generation"]
                        backend.recover_existing = recovered
                        final = broker.takeover({"environmentId": "transition", "scope": "scope", "generation": int(after),
                                                 "controlAuthorizationId": "next"})
                        self.assertEqual(final["generation"], int(after) + 1)
                    finally:
                        broker.close()

    def test_same_process_takeover_reloads_generation_after_pending_ack_loss(self):
        actual = [1]
        self.backend.isolate = lambda env: {"generation": actual[0]}
        old = self.broker.environments["env"]
        self.broker._save_env({**old, "state": "draining", "lease": None,
                               "pendingControl": {"mode": "human", "generation": 1}})
        def recover(old, new):
            self.assertEqual(old["generation"], 1)
            self.assertEqual(new["generation"], 2)
            actual[0] = 2
        self.backend.recover_existing = recover
        self.assertEqual(self.takeover()["generation"], 2)

    def test_expired_owner_release_is_idempotent_after_ack_loss_and_cannot_stop_new_generation(self):
        req = self.request()
        self.now += 61
        with self.assertRaises(BrokerError):
            self.broker.execute(req)
        with patch.object(self.backend, "isolate", wraps=self.backend.isolate) as isolate:
            result = self.broker.release(req)
            self.assertEqual(result["state"], "quarantined")
            self.assertNotIn("releaseReceipt", result)
            self.assertEqual(self.broker.release(req), result)
            self.assertEqual(isolate.call_count, 1)
            with self.assertRaises(BrokerError):
                self.broker.release({**req, "token": "wrong"})
        self.takeover()
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "new", "ttlSeconds": 60})
        with self.assertRaises(BrokerError):
            self.broker.release(req)
        self.assertEqual(self.broker.execute(self.request("new-operation", fresh))["status"], "succeeded")

    def test_failed_physical_release_retains_proof_and_can_finish_isolation(self):
        self.backend.fail_stop = True
        try:
            with self.assertRaises(BrokerError):
                self.broker.release(self.request())
        finally:
            self.backend.fail_stop = False
        self.assertEqual(self.broker.release(self.request())["state"], "quarantined")

    def test_file_verify_requires_existing_same_environment_scope_and_attempt(self):
        original = self.request("source")
        self.broker.execute(original)
        verify = {**self.request("verify"), "arguments": {"mode": "verify", "path": "file",
                  "original": {"operationId": "source", "attemptId": "attempt"}}}
        for reference in ({"operationId": "unknown", "attemptId": "attempt"},
                          {"operationId": "source", "attemptId": "wrong"}):
            with self.subTest(reference=reference), self.assertRaises(BrokerError):
                self.broker.execute({**verify, "arguments": {**verify["arguments"], "original": reference}})
        self.assertEqual(len(self.backend.requests), 1)
        self.broker.create({"environmentId": "other", "scope": "scope", "workspaceId": "other-ws",
                           "resourceIds": ["other"], "image": "example.org/tools@sha256:" + "1" * 64,
                           "network": "none"})
        other = self.broker.acquire({"environmentId": "other", "scope": "scope", "workflowId": "flow", "ttlSeconds": 60})
        other_verify = {**verify, "environment": other["environment"], "token": other["token"]}
        with self.assertRaisesRegex(BrokerError, "original-operation-not-found"):
            self.broker.execute(other_verify)
        self.assertEqual(self.broker.execute(verify)["status"], "succeeded")

    def test_gui_verify_checks_original_identity_and_preserves_unknown(self):
        original = {**self.request("gui-source"), "toolName": "gui.act"}
        self.backend.collect = lambda *_: {"status": "unknown", "result": {"reason": "receipt-lost"}}
        self.assertEqual(self.broker.execute(original)["status"], "unknown")
        record_key = next(k for k, value in self.broker.operations.items() if value["operationId"] == "gui-source")
        saved = json.loads(json.dumps(self.broker.operations[record_key]))
        verify = {**self.request("gui-verify"), "toolName": "gui.verify", "arguments": {
            "original": {"operationId": "gui-source", "attemptId": "attempt"}, "contains": "current text"}}
        for field, value in (("operationId", "missing"), ("attemptId", "wrong")):
            with self.subTest(field=field), self.assertRaises(BrokerError):
                self.broker.execute({**verify, "arguments": {**verify["arguments"], "original": {
                    **verify["arguments"]["original"], field: value}}})
        # 历史条目的身份由恢复日志提供；逐项污染该边界，验证新请求不能错误关联。
        for field, value in (("scope", "other"), ("toolName", "browser.act"),
                             ("environmentId", "other"), ("workspaceId", "other-ws")):
            changed = json.loads(json.dumps(saved))
            target = changed["body"]["environment"] if field in ("environmentId", "workspaceId") else changed["body"]
            target[field] = value
            self.broker.operations[record_key] = changed
            try:
                with self.subTest(field=field), self.assertRaisesRegex(BrokerError, "original-operation-mismatch"):
                    self.broker.execute(verify)
            finally:
                self.broker.operations[record_key] = saved
        self.assertEqual(self.backend.effects, 1)
        self.backend.collect = lambda *_: {"status": "succeeded", "result": {"matched": True}}
        self.assertTrue(self.broker.execute(verify)["result"]["matched"])
        self.assertEqual(self.broker.operations[record_key], saved)
        self.assertEqual(saved["outcome"]["status"], "unknown")

    def begin_human(self):
        control = {"environmentId": "env", "scope": "scope", "generation": 0,
                   "controlAuthorizationId": "manual", "humanSession": {
                       "id": "a" * 64, "token": "human-secret-" * 4, "ttlSeconds": 60}}
        public = self.broker.handoff(control)
        credential = {"environmentId": "env", "scope": "scope", "generation": 1,
                      "sessionId": control["humanSession"]["id"], "token": control["humanSession"]["token"]}
        return control, credential, public

    def human_request(self, credential, operation="human-op"):
        return {**self.request(operation), **credential, "toolName": "gui.act", "arguments": {"action": "click"}}

    def test_human_session_is_private_idempotent_and_permit_bounded(self):
        control, credential, public = self.begin_human()
        self.assertEqual(self.broker.handoff(control), public)
        self.assertEqual(len(self.backend.handoffs), 1)
        self.assertNotIn("token", json.dumps(public))
        self.assertNotIn(credential["token"], "".join(p.read_text() for p in self.broker.journal.path.glob("*.json")))
        req = self.human_request(credential)
        self.assertEqual(self.broker.human_execute(req)["status"], "succeeded")
        sent = self.backend.requests[-1]
        self.assertEqual(sent["kind"], "human-operation")
        self.assertEqual(sent["permit"]["humanSessionId"], credential["sessionId"])
        self.assertEqual(sent["permit"]["expiresAt"], "1970-01-01T00:17:40Z")
        self.assertEqual(self.broker.human_execute(req)["status"], "succeeded")
        self.assertEqual(self.backend.effects, 1)
        self.now += 10
        self.broker.human_renew({**credential, "ttlSeconds": 300})
        self.assertEqual(sent["permit"]["expiresAt"], "1970-01-01T00:17:40Z")
        for change in ({"token": "wrong"}, {"generation": 0}, {"sessionId": "b" * 64}):
            with self.subTest(change=change), self.assertRaises(BrokerError):
                self.broker.human_execute({**self.human_request(credential, "denied"), **change})
        with self.assertRaisesRegex(BrokerError, "human-tool-not-allowed"):
            self.broker.human_execute({**self.human_request(credential, "shell"), "toolName": "shell.exec"})
        self.assertEqual(self.backend.effects, 1)

    def test_human_close_expiry_and_resume_revoke_manual_credentials(self):
        _, credential, _ = self.begin_human()
        running = set(self.backend.running)
        self.now += 61
        with self.assertRaises(BrokerError):
            self.broker.human_execute(self.human_request(credential))
        self.broker.expire_humans()
        env = self.broker.inspect({"environmentId": "env", "scope": "scope"})
        self.assertEqual((env["state"], env["generation"]), ("human", 2))
        self.assertEqual(self.broker.human_close(credential), env)
        self.assertEqual(self.backend.running, running)
        self.assertNotIn("human", env)
        with self.assertRaises(BrokerError):
            self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "flow"})
        self.broker.resume({"environmentId": "env", "scope": "scope", "generation": 2, "controlAuthorizationId": "resume"})
        with self.assertRaises(BrokerError):
            self.broker.human_execute(self.human_request(credential))
        self.assertEqual(self.backend.effects, 0)

    def test_human_close_failed_ack_stays_draining_and_same_close_recovers(self):
        _, credential, _ = self.begin_human()
        handoff = self.backend.handoff
        self.backend.handoff = lambda *_: {"helperProtocolVersion": 1, "automationIsolated": True,
                                         "humanInputsIsolated": False, "generation": 2, "mode": "human"}
        with self.assertRaisesRegex(BrokerError, "human-input-isolation-unconfirmed"):
            self.broker.human_close(credential)
        self.assertEqual(self.broker.environments["env"]["state"], "draining")
        self.assertEqual(self.broker.environments["env"]["generation"], 1)
        with self.assertRaises(BrokerError):
            self.broker.human_execute(self.human_request(credential))
        self.backend.handoff = handoff
        self.assertEqual(self.broker.human_close(credential)["state"], "human")
        self.assertEqual(self.backend.effects, 0)

    def test_human_lost_receipt_stops_manual_inputs_and_queries_original_unknown(self):
        _, credential, _ = self.begin_human()
        self.backend.fail_after_effect = True
        req = self.human_request(credential)
        result = self.broker.human_execute(req)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(self.broker.environments["env"]["state"], "human")
        self.assertIsNone(self.broker.environments["env"]["humanSession"])
        query = {"environmentId": "env", "scope": "scope", "operationId": "human-op"}
        self.assertEqual(self.broker.human_query(query), {"operationId": "human-op", "attemptId": "attempt", "outcome": result})
        with self.assertRaises(BrokerError):
            self.broker.human_execute(req)
        self.assertEqual(self.backend.effects, 1)
        self.assertIn(self.broker.environments["env"]["container"], self.backend.running)

    def test_production_tmpfs_ownership_uses_supported_U_option(self):
        backend = PodmanBackend()
        calls = []
        def command(*args, **_kwargs):
            calls.append(args)
            return b'[{"State":{"Running":true}}]' if args[0] == "inspect" else b""
        with patch.object(backend, "command", side_effect=command), patch.object(backend, "launch"), patch.object(backend, "collect", return_value={"helperProtocolVersion": 1, "ready": True, "generation": 0}):
            backend.create({**self.env, "container": "controlled", "network": "none"})
        args = calls[0]
        self.assertIn("--user=1000:1000", args)
        self.assertIn("--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,mode=0700,U", args)
        self.assertIn("--read-only", args)
        self.assertIn("--cap-drop=ALL", args)
        self.assertIn("--security-opt=no-new-privileges", args)

    def test_gui_creation_uses_persisted_kind_fixed_uid_and_managed_budget(self):
        backend = PodmanBackend()
        calls = []
        env = {**self.env, "container": "controlled", "desktopKind": "gui", "sandboxPolicy": "chromium-v1"}
        with self.assertRaisesRegex(BrokerError, "managed-resource-slice-required"):
            backend.create(env)
        backend.shell = SimpleNamespace(configure_environment=lambda value: "controlled.slice")
        def command(*args, **_kwargs):
            calls.append(args)
            return b'[{"State":{"Running":true}}]' if args[0] == "inspect" else b""
        with patch.object(backend, "prepare_gui_home") as home, patch.object(backend, "chromium_profile", return_value=Path("profile")), patch.object(backend, "command", side_effect=command), patch.object(backend, "launch"), patch.object(backend, "collect", return_value={"helperProtocolVersion": 1, "ready": True, "generation": 0, "capabilities": ["gui.observe", "gui.act", "gui.verify"]}):
            backend.create(env)
            home.assert_called_once_with(env)
        run = calls[0]
        for option in ("--pids-limit=384", "--memory=2g", "--cgroup-parent=controlled.slice", "--user=1000:1000", "--cap-drop=ALL", "--read-only"):
            self.assertIn(option, run)
        self.assertEqual(run[-3:], ("--entrypoint=/usr/local/bin/node", env["image"], "/opt/kaguya-tools/gui-init.mjs"))
        self.assertIn(("exec", "--detach", "--user=1001:1001", "controlled", "/usr/bin/python3", "/opt/kaguya-tools/gui-app-session.py"), calls)
        self.assertNotIn("--env=KAGUYA_BROWSER_ENABLED=1", run)
        self.assertTrue(any("/run/kaguya-app/session/ready" in item for call in calls for item in call))

    def test_gui_requires_explicit_sandbox_and_valid_kind(self):
        for extra, message in (({"desktopKind": "other"}, "desktop-kind"), ({"desktopKind": "gui"}, "gui-sandbox")):
            with self.subTest(extra=extra), self.assertRaisesRegex(BrokerError, message):
                self.broker.create({"environmentId": "another", "image": self.env["image"], **extra})

    def test_chromium_profile_is_explicit_and_keeps_outer_isolation(self):
        backend = PodmanBackend()
        calls = []
        def command(*args, **_kwargs):
            calls.append(args)
            return b'[{"State":{"Running":true}}]' if args[0] == "inspect" else b""
        with patch.object(backend, "chromium_profile", return_value=Path(__file__).with_name("chromium-seccomp.json")), patch.object(backend, "command", side_effect=command), patch.object(backend, "launch"), patch.object(backend, "collect", return_value={"helperProtocolVersion": 1, "ready": True, "generation": 0}):
            backend.create({**self.env, "container": "controlled", "network": "none", "sandboxPolicy": "chromium-v1"})
        args = calls[0]
        profile_arg = next(a for a in args if a.startswith("--security-opt=seccomp="))
        profile = json.loads(Path(profile_arg.split("=", 2)[2]).read_text())
        self.assertEqual(profile["defaultAction"], "SCMP_ACT_ERRNO")
        self.assertEqual([r for r in profile["syscalls"] if "chroot" in r["names"]], [{
            "names": ["chroot"], "action": "SCMP_ACT_ALLOW", "args": [],
            "comment": "Chromium sandbox chroot inside its own user namespace; outer container capabilities remain empty.",
            "includes": {}, "excludes": {}}])
        self.assertTrue(any(r["action"] == "SCMP_ACT_ERRNO" and "bpf" in r["names"] for r in profile["syscalls"]))
        for option in ("--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--user=1000:1000", "--pid=private", "--ipc=private"):
            self.assertIn(option, args)
        with self.assertRaisesRegex(BrokerError, "sandbox-policy-not-allowed"):
            self.broker.create({"environmentId": "bad", "image": "example.org/tools@sha256:" + "1" * 64, "sandboxPolicy": "unconfined"})

    def test_chromium_runtime_and_distribution_profile_are_both_required(self):
        for (version, sha), (name, _) in CHROMIUM_POLICIES.items():
            self.assertEqual(chromium_profile(version, sha).name, name)
            with self.assertRaisesRegex(BrokerError, "runtime-policy-unreviewed"):
                chromium_profile(version, "0" * 64)
        with self.assertRaisesRegex(BrokerError, "runtime-policy-unreviewed"):
            chromium_profile("5.7.0", next(sha for version, sha in CHROMIUM_POLICIES if version == "4.9.3"))

    def test_cancel_before_dispatch_persists_tombstone_across_restart(self):
        req = self.request()
        result = self.broker.cancel(self.control(req))
        self.assertEqual(result["evidence"], "not-executed")
        self.assertEqual(self.broker.execute(req)["status"], "cancelled")
        self.assertEqual(self.backend.effects, 0)
        self.broker.close()
        self.broker = Broker(self.root, self.backend, clock=lambda: self.now)
        self.assertIn("op", [x["operationId"] for x in self.broker.operations.values()])
        self.takeover()
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "new", "ttlSeconds": 60})
        result = self.broker.reconcile(self.control(req, fresh))
        self.assertEqual((result["status"], result["evidence"]), ("cancelled", "not-executed"))
        self.assertEqual(self.backend.effects, 0)

    def test_duplicate_operation_runs_once_and_parameter_reuse_rejected(self):
        req = self.request()
        first = self.broker.execute(req)
        self.assertEqual(self.broker.execute(req), first)
        with self.assertRaisesRegex(BrokerError, "operation-conflict"):
            self.broker.execute({**req, "arguments": {"command": "false"}})
        self.assertEqual(self.backend.effects, 1)

    def test_two_workers_do_not_dispatch_twice(self):
        self.backend.finish.clear()
        req = self.request()
        values = []
        t = threading.Thread(target=lambda: values.append(self.broker.execute(req)))
        self.threads.append(t)
        t.start()
        self.assertTrue(self.backend.entered.wait(2))
        self.assertEqual(self.broker.execute(req)["status"], "unknown")
        self.backend.finish.set()
        t.join(3)
        self.assertEqual(self.backend.effects, 1)
        self.assertEqual(values[0]["status"], "succeeded")

    def test_takeover_fences_old_requests_and_retains_old_artifact_generation(self):
        req = self.request()
        receipt = self.broker.execute(req)
        self.takeover()
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "new", "ttlSeconds": 60})
        with self.assertRaisesRegex(BrokerError, "stale-environment"):
            self.broker.execute(self.request("late"))
        result = self.broker.reconcile(self.control(req, fresh))
        self.assertEqual(result, receipt)
        self.assertEqual(result["artifacts"][0]["generation"], 0)
        self.assertEqual(self.backend.effects, 1)

    def test_takeover_does_not_complete_when_old_process_cannot_be_isolated(self):
        self.backend.fail_stop = True
        with self.assertRaisesRegex(BrokerError, "isolation-unconfirmed"):
            self.takeover()
        self.assertEqual(self.broker.environments["env"]["generation"], 0)
        with self.assertRaises(BrokerError):
            self.broker.execute(self.request())
        self.backend.fail_stop = False
        self.takeover()
        self.assertEqual(self.broker.environments["env"]["generation"], 1)

    def test_scope_workspace_resource_workflow_and_token_checked_at_entry(self):
        for field, value in (("workspaceId", "elsewhere"), ("resourceIds", ["other"]),
                             ("workflowId", "other"), ("generation", 8), ("fencing", "99")):
            req = self.request()
            req["environment"] = {**req["environment"], field: value}
            with self.assertRaises(BrokerError):
                self.broker.execute(req)
        with self.assertRaises(BrokerError):
            self.broker.execute({**self.request(), "token": "wrong"})
        with self.assertRaises(BrokerError):
            self.broker.cancel({**self.control(self.request()), "scope": "wrong"})
        self.assertEqual(self.backend.effects, 0)

    def test_expired_lease_cannot_reacquire_without_isolation(self):
        self.now += 61
        with self.assertRaises(BrokerError):
            self.broker.execute(self.request())
        with self.assertRaisesRegex(BrokerError, "takeover-required"):
            self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "flow", "ttlSeconds": 60})

    def test_dispatch_permit_is_bounded_by_lease_and_renewal_cannot_extend_it(self):
        self.backend.finish.clear()
        values = []
        thread = threading.Thread(target=lambda: values.append(self.broker.execute(self.request())))
        self.threads.append(thread)
        thread.start()
        self.assertTrue(self.backend.entered.wait(2))
        permit = dict(self.backend.requests[0]["permit"])
        self.assertEqual(permit["expiresAt"], "1970-01-01T00:17:40Z")
        self.assertEqual(permit["attemptId"], "attempt")
        self.now += 10
        renewed = self.broker.renew({**self.binding, "scope": "scope", "ttlSeconds": 300})
        self.assertNotEqual(renewed["expiresAt"], permit["expiresAt"])
        self.assertEqual(self.backend.requests[0]["permit"], permit)
        self.backend.finish.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertLessEqual(self.backend.timeouts[0], 60)
        self.assertEqual(values[0]["status"], "succeeded")

    def test_operation_deadline_shortens_dispatch_permit(self):
        self.broker.execute({**self.request(), "deadline": "1970-01-01T00:16:45Z"})
        self.assertEqual(self.backend.requests[0]["permit"]["expiresAt"], "1970-01-01T00:16:45Z")
        self.assertEqual(self.backend.timeouts[0], 5)

    def test_handoff_and_resume_preserve_desktop_and_revoke_old_lease(self):
        running = set(self.backend.running)
        self.backend.finish.clear()
        values = []
        thread = threading.Thread(target=lambda: values.append(self.broker.execute(self.request())))
        self.threads.append(thread)
        thread.start()
        self.assertTrue(self.backend.entered.wait(2))
        control = {"environmentId": "env", "scope": "scope", "generation": 0, "controlAuthorizationId": "human"}
        human = self.broker.handoff(control)
        self.assertEqual((human["state"], human["generation"]), ("human", 1))
        self.assertEqual(self.backend.running, running)
        with self.assertRaises(BrokerError):
            self.broker.execute(self.request("late"))
        resumed = self.broker.resume({**control, "generation": 1})
        self.assertEqual((resumed["state"], resumed["generation"]), ("ready", 2))
        self.assertEqual(self.backend.running, running)
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "new"})
        self.backend.finish.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        old = self.broker.reconcile(self.control(self.request(), fresh))
        self.assertEqual(old["artifacts"][0]["generation"], 0)
        self.assertEqual(self.backend.effects, 1)

    def test_failed_handoff_does_not_advance_generation_or_kill_desktop(self):
        running = set(self.backend.running)
        self.backend.handoff = lambda *args: {"automationIsolated": False}
        with self.assertRaisesRegex(BrokerError, "handoff-unconfirmed"):
            self.broker.handoff({"environmentId": "env", "scope": "scope", "generation": 0,
                                 "controlAuthorizationId": "human"})
        self.assertEqual(self.broker.environments["env"]["generation"], 0)
        self.assertEqual(self.broker.environments["env"]["state"], "draining")
        self.assertEqual(self.backend.running, running)
        with self.assertRaises(BrokerError):
            self.broker.execute(self.request())

    def test_lost_resume_ack_can_retry_same_control_transition_without_rebuilding_desktop(self):
        control = {"environmentId": "env", "scope": "scope", "generation": 0, "controlAuthorizationId": "human"}
        self.broker.handoff(control)
        control["generation"] = 1
        handoff = self.backend.handoff
        replies = {}
        calls = []
        def lost_reply(env, generation, mode):
            calls.append((generation, mode))
            key = (generation, mode)
            if key in replies:
                return replies[key]
            replies[key] = handoff(env, generation, mode)
            raise BrokerError("reply-lost")
        self.backend.handoff = lost_reply
        with self.assertRaisesRegex(BrokerError, "reply-lost"):
            self.broker.resume(control)
        self.assertEqual(self.broker.environments["env"]["generation"], 1)
        self.assertEqual(self.broker.environments["env"]["state"], "draining")
        self.assertEqual(self.broker.resume(control)["generation"], 2)
        self.assertEqual(len(self.backend.running), 1)
        self.assertEqual(calls, [(2, "automation"), (2, "automation")])
        self.assertEqual(self.backend.handoffs[-1][1:], (2, "automation"))
        self.assertEqual(len(self.backend.handoffs), 2)  # human + 一次实际 resume

    def test_identical_artifact_bytes_keep_distinct_immutable_capture_identity(self):
        first = self.broker.execute(self.request())["artifacts"][0]
        second = self.broker.execute({**self.request("second"), "attemptId": "second-attempt"})["artifacts"][0]
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["hash"], second["hash"])
        self.assertEqual(self.broker.artifacts[first["id"]]["attemptId"], "attempt")
        self.assertEqual(self.broker.artifacts[second["id"]]["attemptId"], "second-attempt")
        self.assertEqual(len(list(self.broker.blobs.iterdir())), 1)

    def test_binary_artifact_budget_keeps_returned_outcome_and_workspace_receipt(self):
        raw = {"status": "succeeded", "result": {"exitCode": 0, "exports": [{
               "path": "reports/result.pdf", "size": 7, "hash": "abc"}]},
               "artifacts": [{"mime": "application/pdf", "dataBase64": base64.b64encode(b"pdfdata").decode()}]}
        self.backend.collect = lambda *_: raw
        accepted = self.broker.execute(self.request())
        self.assertEqual(accepted["artifacts"][0]["mime"], "application/pdf")
        snapshot = {p.name: p.read_bytes() for p in self.broker.blobs.iterdir()}
        stored_bytes = sum(map(len, snapshot.values()))
        self.broker.max_artifact_bytes = 1
        raw["artifacts"][0]["dataBase64"] = base64.b64encode(b"oversize-new-pdf").decode()
        large = self.broker.execute(self.request("large"))
        self.assertEqual((large["status"], large["truncated"], large["artifacts"]), ("succeeded", True, []))
        self.assertEqual(large["result"], raw["result"])
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in self.broker.blobs.iterdir()})
        self.broker.max_artifact_bytes = 100
        self.broker.max_stored_bytes = stored_bytes
        raw["artifacts"][0]["dataBase64"] = base64.b64encode(b"full-storage-new-pdf").decode()
        full = self.broker.execute(self.request("full"))
        self.assertEqual((full["status"], full["truncated"]), ("succeeded", True))
        self.assertEqual(full["artifacts"], [])
        self.assertEqual(full["result"], raw["result"])
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in self.broker.blobs.iterdir()})
        self.assertEqual(sum(p.stat().st_size for p in self.broker.blobs.iterdir()), stored_bytes)
        self.assertEqual(self.backend.effects, 3)

    def test_effect_then_transport_loss_stays_unknown_without_reexecution(self):
        self.backend.fail_after_effect = True
        req = self.request()
        self.assertEqual(self.broker.execute(req)["status"], "unknown")
        self.assertFalse(self.backend.running)
        self.takeover()
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "new", "ttlSeconds": 60})
        self.assertEqual(self.broker.reconcile(self.control(req, fresh))["status"], "unknown")
        with self.assertRaises(BrokerError):
            self.broker.execute(req)
        self.assertEqual(self.backend.effects, 1)

    def test_missing_journal_is_not_proof_of_no_effect(self):
        result = self.broker.reconcile(self.control(self.request()))
        self.assertEqual((result["status"], result["evidence"]), ("unknown", "unconfirmed"))

    def test_secrets_are_not_written_to_journal_or_passed_to_helper(self):
        self.broker.execute(self.request())
        data = "".join(p.read_text() for p in self.root.rglob("*.json"))
        self.assertNotIn(self.binding["token"], data)
        self.assertNotIn("dataBase64", data)
        self.assertNotIn(self.binding["token"], json.dumps(self.backend.requests))

    def test_artifact_read_uses_original_scope_and_no_arbitrary_path(self):
        result = self.broker.execute(self.request())
        artifact = result["artifacts"][0]
        data = self.broker.read_artifact({"id": artifact["id"], "scope": "scope"})
        self.assertEqual(base64.b64decode(data["dataBase64"]), b"receipt")
        with self.assertRaises(BrokerError):
            self.broker.read_artifact({"id": artifact["id"], "scope": "other"})
        with self.assertRaises(BrokerError):
            self.broker.read_artifact({"id": "../../passwd", "scope": "scope"})

    def test_recovery_isolates_old_container_and_requires_explicit_takeover(self):
        self.broker.execute(self.request())
        self.broker.close()
        self.broker = Broker(self.root, self.backend, clock=lambda: self.now)
        self.assertFalse(self.backend.running)
        self.assertEqual(self.broker.environments["env"]["state"], "quarantined")
        with self.assertRaises(BrokerError):
            self.broker.execute(self.request("late"))

    def test_close_reopen_then_late_collect_cannot_overwrite_new_journal(self):
        self.backend.finish.clear()
        self.backend.isolate = lambda env: self.backend.running.discard(env["container"])
        original = self.broker
        values = []
        thread = threading.Thread(target=lambda: values.append(original.execute(self.request())))
        self.threads.append(thread)
        thread.start()
        self.assertTrue(self.backend.entered.wait(2))
        original.close()
        self.broker = Broker(self.root, self.backend, clock=lambda: self.now)
        snapshot = {p.name: p.read_bytes() for p in (self.root / "journal").glob("*.json")}
        blobs = {p.name: p.read_bytes() for p in (self.root / "artifacts").iterdir()}
        self.backend.finish.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(snapshot, {p.name: p.read_bytes() for p in (self.root / "journal").glob("*.json")})
        self.assertEqual(blobs, {p.name: p.read_bytes() for p in (self.root / "artifacts").iterdir()})
        self.assertEqual(values[0]["status"], "unknown")
        with self.assertRaisesRegex(BrokerError, "journal-closed"):
            original.journal.append("environment", "env", {})

    def test_journal_never_overwrites_an_existing_sequence(self):
        sequence = self.broker.journal.sequence + 1
        path = self.root / "journal" / f"{sequence:016d}.json"
        path.write_bytes(b"preserve")
        with self.assertRaises(FileExistsError):
            self.broker.journal.append("environment", "env", {})
        self.assertEqual(path.read_bytes(), b"preserve")
        path.unlink()

    def test_distinct_workflows_cannot_lease_shared_resources(self):
        with self.assertRaisesRegex(BrokerError, "takeover-required"):
            self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "other", "ttlSeconds": 60})
        with self.assertRaisesRegex(BrokerError, "resource-already-owned"):
            self.broker.create({"environmentId": "other", "scope": "scope", "workspaceId": "other",
                                "resourceIds": ["browser"], "image": self.env["image"]})

    def test_active_takeover_isolates_before_new_generation_and_keeps_late_receipt(self):
        self.backend.finish.clear()
        # 模拟已产生效果、结果尚在传输；isolate 不替测试释放结果屏障。
        def isolate(env):
            self.backend.running.discard(env["container"])
            self.backend.isolated.set()
        self.backend.isolate = isolate
        values = []
        req = self.request()
        thread = threading.Thread(target=lambda: values.append(self.broker.execute(req)))
        self.threads.append(thread)
        thread.start()
        self.assertTrue(self.backend.entered.wait(2))
        with self.assertRaisesRegex(BrokerError, "environment-operation-in-flight"):
            self.broker.execute(self.request("other-op"))
        self.takeover()
        self.assertTrue(self.backend.isolated.is_set())
        self.assertNotIn("kaguya-" + __import__("broker").digest("env")[:20] + "-0", self.backend.running)
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "next", "ttlSeconds": 60})
        self.backend.finish.set()
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.broker.reconcile(self.control(req, fresh))["status"], "succeeded")
        self.assertEqual(self.backend.effects, 1)

    def test_active_cancel_stops_environment_and_preserves_effect_evidence(self):
        self.backend.finish.clear()
        req = self.request()
        values = []
        thread = threading.Thread(target=lambda: values.append(self.broker.execute(req)))
        self.threads.append(thread)
        thread.start()
        self.assertTrue(self.backend.entered.wait(2))
        self.assertEqual(self.broker.cancel(self.control(req))["status"], "unknown")
        self.assertTrue(self.backend.isolated.is_set())
        thread.join(3)
        self.assertFalse(thread.is_alive())
        self.takeover()
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "next", "ttlSeconds": 60})
        self.assertEqual(self.broker.reconcile(self.control(req, fresh))["status"], "succeeded")
        self.assertEqual(self.backend.effects, 1)

    def test_expired_request_has_zero_effect_and_helper_timeout_never_replays(self):
        expired = {**self.request(), "deadline": "1970-01-01T00:00:00Z"}
        with self.assertRaisesRegex(BrokerError, "operation-deadline-expired"):
            self.broker.execute(expired)
        self.assertEqual(self.backend.effects, 0)
        def timeout(handle, budget):
            self.assertGreater(budget, 0)
            self.assertLessEqual(budget, 300)
            raise BrokerError("helper-timeout")
        self.backend.collect = timeout
        req = self.request()
        self.assertEqual(self.broker.execute(req)["status"], "unknown")
        with self.assertRaises(BrokerError):
            self.broker.execute(req)
        self.assertEqual(self.backend.effects, 1)
        self.assertFalse(self.backend.running)

    def test_helper_unproved_rejection_and_cancellation_become_unknown(self):
        for i, status in enumerate(("rejected", "cancelled")):
            self.backend.collect = lambda handle, budget: {"status": status, "result": {}, "artifacts": []}
            result = self.broker.execute(self.request("op" + str(i)))
            self.assertEqual((result["status"], result["evidence"]), ("unknown", "unconfirmed"))

    def test_old_observation_cannot_be_used_by_new_generation(self):
        self.takeover()
        fresh = self.broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "next", "ttlSeconds": 60})
        req = self.request(binding=fresh)
        req["toolName"] = "gui.act"
        req["arguments"] = {"observation": {"environmentId": "env", "generation": 0, "workflowId": "flow"}}
        with self.assertRaisesRegex(BrokerError, "stale-observation"):
            self.broker.execute(req)
        self.assertEqual(self.backend.effects, 0)

    def add_second_environment(self):
        return self.broker.create({"environmentId": "other", "scope": "scope", "workspaceId": "other",
                                   "resourceIds": ["other"], "image": self.env["image"]})

    def test_close_with_disk_full_still_isolates_every_environment(self):
        self.add_second_environment()
        with patch.object(self.broker.journal, "append", side_effect=OSError("ENOSPC")):
            with self.assertRaisesRegex(BrokerError, "close-isolation-unconfirmed"):
                self.broker.close()
        self.assertFalse(self.backend.running)
        self.assertIsNone(self.broker.journal.lockfile)

    def test_recovery_with_journal_io_error_isolates_all_before_refusing_start(self):
        self.add_second_environment()
        containers = set(self.backend.running)
        self.broker.close()
        self.backend.running = containers
        with patch("broker.Journal.append", side_effect=OSError("EIO")):
            with self.assertRaisesRegex(BrokerError, "recovery-isolation-or-journal-failed"):
                Broker(self.root, self.backend)
        self.assertFalse(self.backend.running)
        # 失败构造没有泄漏 flock。
        self.broker = Broker(self.root, self.backend)

    def test_ready_journal_failure_cannot_leave_new_container_running(self):
        append = self.broker.journal.append
        def failed_ready(kind, key, value):
            if kind == "environment" and key == "other" and value["state"] == "ready":
                raise OSError("ENOSPC")
            return append(kind, key, value)
        with patch.object(self.broker.journal, "append", side_effect=failed_ready):
            with self.assertRaisesRegex(BrokerError, "environment-create-unconfirmed"):
                self.add_second_environment()
        self.assertEqual(len(self.backend.running), 1)
        self.assertTrue(self.broker.faulted)

    def test_create_and_close_keep_physical_isolation_inside_same_environment_lock(self):
        creating, release_create, closing = threading.Event(), threading.Event(), threading.Event()
        self.addCleanup(release_create.set)
        original_create, original_isolate = self.backend.create, self.backend.isolate
        errors = []
        def create(env):
            creating.set()
            if not release_create.wait(3):
                raise AssertionError("create barrier not released")
            original_create(env)
        def isolate(env):
            closing.set()
            original_isolate(env)
        def guarded(fn):
            try:
                fn()
            except Exception as error:
                errors.append(error)
        self.backend.create = create
        self.backend.isolate = isolate
        creator = threading.Thread(target=lambda: guarded(self.add_second_environment))
        closer = threading.Thread(target=lambda: guarded(self.broker.close))
        self.threads.extend((creator, closer))
        creator.start()
        self.assertTrue(creating.wait(2))
        closer.start()
        self.assertTrue(closing.wait(2))
        self.assertTrue(closer.is_alive())
        release_create.set()
        creator.join(3)
        closer.join(3)
        self.assertFalse(self.backend.running)
        self.assertIsNone(self.broker.journal.lockfile)
        self.assertFalse(errors)


if __name__ == "__main__":
    unittest.main()
