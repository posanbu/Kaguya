#!/usr/bin/env python3
"""功能概述：GitHub 临时 Linux runner 上实证宿主 supervisor 与 rootless shell 容器。
主要职责：复用生产 PodmanBackend/ShellJobs，验证真实 argv、退出码/信号区分与 stderr、文件、私有控制面与完整停止。
代码库关系：镜像由同一 workflow 构建；记录实际 runtime/policy，不能替代生产策略验收。
输入输出与副作用：随机环境/命名卷/unit，finally 停止全部已登记成员后清理；失败输出监督日志。
"""
import argparse
import base64
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "linux-environments"))
from broker import PodmanBackend, BrokerError, digest  # noqa: E402
from supervisor_checks import check_gate, check_deadlines, check_broker_crash, check_startup_window, cleanup_all  # noqa: E402


def until(read, predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while True:
        value = read()
        if predicate(value):
            return value
        if time.monotonic() >= deadline:
            raise AssertionError({"waitTimeout": value})
        time.sleep(0.02)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", required=True)
    parser.add_argument("--digest", required=True)
    args = parser.parse_args()
    backend = PodmanBackend()
    backend.env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")}
    backend.env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    def command(*values, timeout=30):
        result = subprocess.run(["/usr/bin/podman", *values], env=backend.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            print(json.dumps({"command": values, "error": result.stderr.decode()}), flush=True)
            raise BrokerError("podman-command-failed")
        return result.stdout
    backend.command = command
    info = json.loads(command("info", "--format=json"))
    assert info["host"]["security"]["rootless"] is True and info["host"]["cgroupVersion"] == "v2"
    print(json.dumps({"runtimeEvidence": info}), flush=True)
    command("load", "--input", str(Path(args.archive).resolve()), timeout=300)
    inspected = json.loads(command("image", "inspect", "localhost/kaguya-shell:ci"))[0]
    assert inspected["Digest"] == args.digest
    key = "ci-" + uuid.uuid4().hex
    env = {"environmentId": key, "workspaceId": key, "generation": 0, "container": key + "-desktop",
           "network": "none", "image": "localhost/kaguya-shell@" + args.digest}
    with tempfile.TemporaryDirectory(prefix="kaguya-shell-") as root:
        backend.configure(root)
        def operation(mode, ttl=30, **values):
            now = datetime.now(timezone.utc)
            op_id = uuid.uuid4().hex
            ref = {"environmentId": key, "generation": env["generation"], "fencing": str(env["generation"] + 1),
                   "leaseId": "lease", "workflowId": "flow"}
            req = {"helperProtocolVersion": 1, "kind": "operation", "environment": ref, "scope": "ci",
                   "operationId": op_id, "attemptId": op_id, "digest": op_id,
                   "deadline": (now + timedelta(seconds=ttl)).isoformat(), "toolName": "shell.exec", "target": {},
                   "arguments": {"mode": mode, **values}, "permit": {**ref, "operationId": op_id, "attemptId": op_id,
                   "digest": op_id, "expiresAt": (now + timedelta(seconds=ttl)).isoformat()}}
            return backend.collect(backend.launch(env, req), ttl)
        try:
            backend.create(env)
            desktop = json.loads(command("inspect", env["container"]))[0]
            oci = json.loads(command("unshare", "/bin/cat", desktop["OCIConfigPath"]))
            print(json.dumps({"desktopPolicy": oci["linux"], "desktopProcess": oci["process"]}), flush=True)
            assert command("exec", env["container"], "stat", "-c", "%u:%g:%a", "/home/tool").strip() == b"1000:1000:700"
            start = operation("start", argv=["/usr/local/bin/node", "-e", "require('fs').writeFileSync('marker','actual-container');console.log('actual-output')"], cwd=".", env={})["result"]
            assert start["accepted"]
            state = until(lambda: operation("query", jobId=start["jobId"])["result"], lambda r: r["state"] in ("exited", "stopped", "unknown"))
            assert state["state"] == "exited" and state["exitCode"] == 0, state
            original = {k: start[k] for k in ("operationId", "attemptId")}
            verified = operation("verify", path="marker", original=original)["result"]
            assert verified["sha256"] == hashlib.sha256(b"actual-container").hexdigest()
            logs = operation("export", jobId=start["jobId"], stream="stdout", mime="text/plain")
            assert base64.b64decode(logs["artifacts"][0]["dataBase64"]) == b"actual-output\n"
            failed = operation("start", argv=["/bin/sh", "-c", "printf failure >&2; exit 23"], cwd=".", env={})["result"]
            failed_state = until(lambda: operation("query", jobId=failed["jobId"])["result"], lambda r: r["state"] in ("exited", "stopped", "unknown"))
            assert failed_state["state"] == "exited" and failed_state["exitCode"] == 23, failed_state
            error_output = operation("export", jobId=failed["jobId"], stream="stderr", mime="text/plain")
            assert base64.b64decode(error_output["artifacts"][0]["dataBase64"]) == b"failure"
            for argv, expected in [
                (["/bin/sh", "-c", "exit 128"], {"kind": "exit", "code": 128}),
                (["/bin/sh", "-c", "exit 143"], {"kind": "exit", "code": 143}),
                (["/usr/bin/python3", "-c", "import os;os.kill(os.getpid(),15)"], {"kind": "signal", "number": 15}),
            ]:
                signaled = operation("start", argv=argv, cwd=".", env={})["result"]
                result = until(lambda: operation("query", jobId=signaled["jobId"])["result"], lambda r: r["state"] in ("exited", "stopped", "unknown"))
                assert result["state"] == "exited" and result["exitStatus"] == expected, result
                assert result["exitCode"] == expected.get("code"), result
                assert result["signal"] == ("SIGTERM" if expected["kind"] == "signal" else None), result
            code = """const f=require('fs'),a=require('assert');
for(const p of ['/home/tool/kaguya-tools.sock','/private','/run/podman/podman.sock','/workspace/.kaguya-tools']) a.equal(f.existsSync(p),false,p);
a.equal(process.getuid(),1000); for(const p of ['/proc/1/fd/0','/proc/1/fd/1','/proc/1/fd/2','/proc/1/mem']) a.throws(()=>f.openSync(p,'w'),e=>['EACCES','EPERM'].includes(e.code)); for(const d of f.readdirSync('/proc/self/fd')){try{a.equal(f.readlinkSync('/proc/self/fd/'+d).includes('shell-jobs'),false)}catch(e){if(e.code!=='ENOENT')throw e}}
f.writeFileSync('isolation.json',JSON.stringify({pid:f.readlinkSync('/proc/self/ns/pid'),net:f.readlinkSync('/proc/self/ns/net')}));"""
            # /private exists in image but is empty; the trusted persistent volume is never mounted in a job.
            code = code.replace("'/private',", "") + "require('assert').deepEqual(require('fs').readdirSync('/private'),[]);"
            isolated = operation("start", argv=["/usr/local/bin/node", "-e", code], cwd=".", env={})["result"]
            state = until(lambda: operation("query", jobId=isolated["jobId"])["result"], lambda r: r["state"] in ("exited", "stopped", "unknown"))
            assert state["state"] == "exited" and state["exitCode"] == 0, state
            sandbox = json.loads(base64.b64decode(operation("export", path="isolation.json", mime="application/json")["artifacts"][0]["dataBase64"]))
            assert sandbox["pid"] != command("exec", env["container"], "readlink", "/proc/1/ns/pid").decode().strip()
            assert sandbox["net"] != command("exec", env["container"], "readlink", "/proc/1/ns/net").decode().strip()
            long = operation("start", ttl=12, argv=["/bin/sh", "-c", "echo ready > alive; exec sleep 120"], cwd=".", env={})["result"]
            record = json.loads((backend.shell.root / long["jobId"] / "manifest.json").read_text())
            stopped = operation("stop", jobId=long["jobId"])["result"]
            assert stopped["state"] == "stopped" and backend.shell.stopped(record), stopped
            check_gate(backend, env, operation, root)
            check_startup_window(backend, env)
            check_deadlines(backend, env, operation)
            check_broker_crash(backend, env["image"], root)
            ack = backend.handoff(env, 1, "human")
            assert ack["automationIsolated"] and json.loads(command("inspect", env["container"]))[0]["State"]["Pid"] == desktop["State"]["Pid"]
            print(json.dumps({"verified": verified, "sandbox": sandbox, "job": state, "stop": stopped, "handoff": ack}), flush=True)
        except BaseException:
            traceback.print_exc()
            for path, record in backend.shell.records(env):
                print(json.dumps({"jobManifest": record, "files": {p.name: p.read_text(errors="replace")[:16000] for p in path.iterdir() if p.is_file()}}), flush=True)
                subprocess.run(["/usr/bin/journalctl", "--user", "-u", record["unit"], "--no-pager", "-n", "80"], env=backend.env)
            raise
        finally:
            actions = []
            for path, record in backend.shell.records(env):
                actions.append(lambda p=path, r=record: backend.shell.stop(p, r, "ci-cleanup"))
                actions.append(lambda r=record: command("rm", "--force", "--ignore", r["container"]))
            actions.extend([lambda: backend.stop_container(env["container"]),
                            lambda: command("rm", "--force", "--ignore", env["container"])])
            for prefix, identity in (("kaguya-workspace-", env["workspaceId"]), ("kaguya-private-", env["environmentId"])):
                actions.append(lambda p=prefix, i=identity: command("volume", "rm", "--force", p + digest(i)[:24]))
            actions.append(lambda: backend.shell.system("/usr/bin/systemctl", "--user", "stop", backend.shell.slice(env)))
            cleanup_all(actions)


if __name__ == "__main__":
    main()
