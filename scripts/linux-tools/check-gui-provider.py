#!/usr/bin/env python3
"""功能概述：以生产 Broker/PodmanBackend/GuiComponent 完成无模型的真实 GTK 操作闭环。
主要职责：固定镜像创建双 UID 桌面、验证持久 HOME/资源预算、原图归档、未知结果去重和双向接管。
代码库关系：GUI workflow 在镜像载入后调用；不替换 GUI 输入实现，只在一次真实结果返回后模拟传输丢失。
输入输出与副作用：合成临时环境、命名卷和 journal；证据不含 token，finally 独立回收容器、卷与 broker。
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "linux-environments"))
from broker import Broker, BrokerError, PodmanBackend, digest


def until(read, accepts, seconds=15):
    deadline = time.monotonic() + seconds
    while True:
        value = read()
        if accepts(value):
            return value
        if time.monotonic() >= deadline:
            raise AssertionError({"conditionTimeout": value})
        time.sleep(.02)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--digest", required=True)
    args = parser.parse_args()
    backend = PodmanBackend()
    backend.env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")}
    backend.env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    key = "gui-provider-" + uuid.uuid4().hex
    evidence = {"imageDigest": args.digest, "events": []}
    env = None
    with tempfile.TemporaryDirectory(prefix="kaguya-gui-provider-") as root:
        broker = Broker(root, backend)
        try:
            broker.create({"environmentId": key, "scope": "ci-gui", "workspaceId": key, "resourceIds": [key],
                           "image": "localhost/kaguya-gui@" + args.digest, "network": "none",
                           "sandboxPolicy": "chromium-v1", "desktopKind": "gui"})
            env = broker.environments[key]
            container = env["container"]
            command = lambda *values: backend.command("exec", container, *values)
            app = lambda *values: backend.command("exec", "--user=1001:1001", container, *values)
            assert command("/usr/bin/stat", "-c", "%u:%g:%a", "/private/app").strip() == b"1001:1001:700"
            assert app("/usr/bin/test", "-w", "/private/app") == b""
            app("/usr/bin/python3", "-I", "-c", "from pathlib import Path; Path('/private/app/recovery-marker').write_text('persistent-gui-home')")
            info = json.loads(backend.command("inspect", container))[0]
            oci = json.loads(backend.command("unshare", "/bin/cat", info["OCIConfigPath"]))
            assert oci["linux"]["resources"]["pids"]["limit"] == 384
            for unit, expected in ((backend.shell.slice(env), b"TasksMax=512"), (backend.shell.job_slice(env), b"TasksMax=112")):
                properties = backend.shell.system("/usr/bin/systemctl", "--user", "show", unit, "--property=TasksMax,MemoryMax").stdout
                assert expected in properties, properties
                evidence[unit] = properties.decode()
            backend.command("exec", "--detach", "--user=1001:1001", container, "/usr/bin/python3", "/opt/kaguya-tools/gui-fixture.py")
            def ledger():
                value = subprocess.run(["/usr/bin/podman", "exec", "--user=1001:1001", container, "/bin/cat", "/home/app/session/gui-ledger.json"], env=backend.env, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=5)
                return json.loads(value.stdout) if value.returncode == 0 else None
            initial = until(ledger, lambda value: value is not None)
            pid = initial["pid"]
            def identity():
                status = app("/bin/cat", f"/proc/{pid}/status").decode()
                assert "1001\t1001\t1001\t1001" in status
                return app("/bin/cat", f"/proc/{pid}/stat").decode().rsplit(")", 1)[1].split()[19]
            started = identity()
            binding = broker.acquire({"environmentId": key, "scope": "ci-gui", "workflowId": "automation", "ttlSeconds": 120})

            def request(tool, arguments, ttl=60):
                operation = uuid.uuid4().hex
                return {**binding, "scope": "ci-gui", "operationId": operation, "attemptId": uuid.uuid4().hex,
                        "intentId": uuid.uuid4().hex, "digest": digest([tool, arguments]), "toolName": tool,
                        "arguments": arguments, "target": {}, "deadline": (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat()}

            def execute(tool, arguments, ttl=60):
                result = broker.execute(request(tool, arguments, ttl))
                evidence["events"].append({"tool": tool, "result": result})
                assert result["status"] in ("succeeded", "unknown"), result
                return result

            desktop = until(lambda: execute("gui.observe", {"target": {"kind": "desktop"}}),
                            lambda value: any(w["pid"] == pid and w["title"] == "Kaguya GUI acceptance" for w in value["result"]["windows"]))
            window = next(w for w in desktop["result"]["windows"] if w["pid"] == pid and w["title"] == "Kaguya GUI acceptance")
            target = {"kind": "window", "pid": pid, "windowId": window["windowId"]}
            observe = lambda ttl=60: execute("gui.observe", {"target": target}, ttl)
            def element(observation, name):
                return next(e["id"] for e in observation["result"]["elements"] if name in e["description"])
            before = until(observe, lambda value: all(any(name in e["description"] for e in value["result"]["elements"])
                                                     for name in ("Unsaved text", "Increment once")))
            original_image = broker.read_artifact({"id": before["artifacts"][0]["id"], "scope": "ci-gui", "environmentId": key})
            image_bytes = base64.b64decode(original_image["dataBase64"])
            assert hashlib.sha256(image_bytes).hexdigest() == before["result"]["image"]["sha256"]
            assert (int.from_bytes(image_bytes[16:20], "big"), int.from_bytes(image_bytes[20:24], "big")) == (600, 300)
            Path("gui-provider-original.png").write_bytes(image_bytes)
            execute("gui.act", {"observation": before["result"]["observation"], "action": "replace", "elementId": element(before, "Unsaved text"), "value": "W8 持久桌面"})
            until(ledger, lambda value: value["text"] == "W8 持久桌面")
            observed = observe()
            click = request("gui.act", {"observation": observed["result"]["observation"], "action": "click", "selector": {"kind": "element", "elementId": element(observed, "Increment once")}})
            collect = backend.collect
            lost = [False]
            def lose_receipt(handle, timeout):
                result = collect(handle, timeout)
                if not lost[0]:
                    lost[0] = True
                    raise BrokerError("synthetic-response-lost-after-real-execution")
                return result
            backend.collect = lose_receipt
            try:
                unknown = broker.execute(click)
            finally:
                backend.collect = collect
            assert unknown["status"] == "unknown", unknown
            until(ledger, lambda value: value["count"] == 1)
            broker.takeover({"environmentId": key, "scope": "ci-gui", "generation": 0, "controlAuthorizationId": "recover"})
            binding = broker.acquire({"environmentId": key, "scope": "ci-gui", "workflowId": "resumed", "ttlSeconds": 120})
            assert broker.reconcile({**click, "token": binding["token"], "controlEnvironment": binding["environment"], "controlAuthorizationId": "query"}) == unknown
            try:
                broker.execute(click)
                raise AssertionError("old-lease-was-admitted")
            except BrokerError:
                pass
            launches = []
            launch = backend.launch
            def counted_launch(environment, body):
                launches.append(body.get("operationId"))
                return launch(environment, body)
            backend.launch = counted_launch
            try:
                try:
                    broker.execute({**click, **binding})
                    raise AssertionError("old-operation-was-redispatched")
                except BrokerError as error:
                    assert str(error) == "operation-conflict", error
                assert launches == [], launches
                assert ledger()["count"] == 1
            finally:
                backend.launch = launch
            verification = execute("gui.verify", {"target": target, "original": {"operationId": click["operationId"], "attemptId": click["attemptId"]}, "verificationKind": "current-gui-state", "contains": "W8 持久桌面"})
            assert verification["result"]["verification"]["matched"] is True
            automatic_capture = observe()["result"]["observation"]
            session = {"id": secrets.token_hex(32), "token": secrets.token_hex(32), "ttlSeconds": 60}
            human = broker.handoff({"environmentId": key, "scope": "ci-gui", "generation": 1, "controlAuthorizationId": "manual", "humanSession": session})
            credential = {"environmentId": key, "scope": "ci-gui", "generation": human["generation"], "sessionId": session["id"], "token": session["token"]}
            def human_execute(tool, arguments):
                req = {**request(tool, arguments), **credential}
                result = broker.human_execute(req)
                evidence["events"].append({"tool": tool, "audience": "human", "result": result})
                return result
            manual = human_execute("gui.observe", {"target": target})
            human_execute("gui.act", {"observation": manual["result"]["observation"], "action": "replace", "elementId": element(manual, "Unsaved text"), "value": "W8 人工暂存"})
            until(ledger, lambda value: value["text"] == "W8 人工暂存")
            manual_capture = human_execute("gui.observe", {"target": target})["result"]["observation"]
            broker.resume({"environmentId": key, "scope": "ci-gui", "generation": 2, "controlAuthorizationId": "resume"})
            try:
                human_execute("gui.act", {"observation": manual_capture, "action": "key", "key": "a"})
                raise AssertionError("old-human-session-was-admitted")
            except BrokerError:
                pass
            binding = broker.acquire({"environmentId": key, "scope": "ci-gui", "workflowId": "final", "ttlSeconds": 120})
            try:
                execute("gui.act", {"observation": automatic_capture, "action": "key", "key": "a"})
                raise AssertionError("old-generation-capture-was-admitted")
            except BrokerError:
                pass
            current = observe(ttl=5)
            expires = datetime.fromisoformat(current["result"]["expiresAt"].replace("Z", "+00:00")).timestamp()
            until(time.time, lambda now: now >= expires, seconds=6)
            expired = execute("gui.act", {"observation": current["result"]["observation"], "action": "key", "key": "a"})
            assert expired["status"] == "unknown"
            assert ledger() == {"uid": 1001, "pid": pid, "text": "W8 人工暂存", "count": 1}
            assert identity() == started
            assert broker.read_artifact({"id": before["artifacts"][0]["id"], "scope": "ci-gui"}) == original_image
            final_image = broker.read_artifact({"id": current["artifacts"][0]["id"], "scope": "ci-gui"})
            Path("gui-provider-final.png").write_bytes(base64.b64decode(final_image["dataBase64"]))
            evidence.update(ledger=ledger(), originalUnknown=unknown, pidStartTime=started,
                            preservedOriginalImageSha256=hashlib.sha256(image_bytes).hexdigest())
            # 交接保留 PID 的证明已经完成；另行模拟容器丢失，核对既存 HOME 卷的恢复。
            backend.stop_container(container)
            broker.takeover({"environmentId": key, "scope": "ci-gui", "generation": 3, "controlAuthorizationId": "restore-container"})
            assert app("/bin/cat", "/private/app/recovery-marker") == b"persistent-gui-home"
            assert app("/usr/bin/stat", "-c", "%u:%g:%a", "/private/app").strip() == b"1001:1001:700"
            evidence["existingHomeRecovered"] = True
            evidence["passed"] = True
        except BaseException:
            evidence["failure"] = traceback.format_exc()
            failed_env = broker.environments.get(key)
            if failed_env:
                try:
                    logs = subprocess.run(["/usr/bin/podman", "logs", failed_env["container"]], env=backend.env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=10)
                    evidence["containerLog"] = logs.stdout.decode(errors="replace")[-16000:]
                except Exception:
                    evidence["containerLog"] = "unavailable"
            raise
        finally:
            primary = sys.exc_info()[1]
            failures = []
            try:
                Path("gui-provider-receipt.json").write_text(json.dumps(evidence, ensure_ascii=False))
            except Exception as error:
                failures.append(error)
            env = broker.environments.get(key, env)
            for cleanup in [broker.close] + ([lambda: backend.stop_container(env["container"]), lambda: backend.command("rm", "--force", "--ignore", env["container"])] if env else []):
                try:
                    cleanup()
                except Exception as error:
                    failures.append(error)
            for prefix in ("kaguya-workspace-", "kaguya-private-"):
                try:
                    backend.command("volume", "rm", "--force", prefix + digest(key)[:24])
                except Exception as error:
                    failures.append(error)
            if failures:
                raise BaseExceptionGroup("gui-provider-cleanup-unconfirmed", ([primary] if primary else []) + failures)


if __name__ == "__main__":
    main()
