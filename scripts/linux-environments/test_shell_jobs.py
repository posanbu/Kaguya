"""功能概述：验证宿主 shell 控制面的持久身份、权限、日志预算和文件读取边界。
主要职责：使用真实临时目录验证不可重复登记、固定 permit、跨 scope 拒绝与路径替换；
真实 systemd/PID namespace/截止崩溃验证位于 check-container.py，不用 mock 冒充隔离成功。
代码库关系：直接测试生产 ShellJobs、file_result/open_beneath；现有 Broker 测试覆盖 token/fence。
输入输出与副作用：每例创建独立目录，所有资源通过 addCleanup/finally 收尾；可显式指定已有 Docker 镜像测试真实 Linux waitpid/防伪通道，不替代 rootless Podman 验收。
"""
from datetime import datetime, timedelta, timezone
import base64
import hashlib
import json
import os
from pathlib import Path
import tempfile
import subprocess
import selectors
import uuid
import time
import unittest
from unittest.mock import patch

from broker import BrokerError
from shell_jobs import ShellJobs, LOG_RESERVATION, file_result, open_beneath, read_json, write_json
from job_runner import container_command, JOB_MONITOR, JobProtocol


class Backend:
    env = {"PATH": "/usr/bin:/bin"}
    def __init__(self, workspace):
        self.workspace = workspace
    def command(self, *args):
        if args[:2] == ("volume", "inspect"):
            return json.dumps([{"Mountpoint": str(self.workspace)}]).encode()
        raise AssertionError(args)


class ShellJobsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.jobs = ShellJobs(self.root / "private", Backend(self.workspace))
        def read_workspace(env, path, expires, *, directory=False, **kwargs):
            if directory:
                fd = open_beneath(self.workspace, path, directory=True)
                os.close(fd)
                return {}
            return file_result(self.workspace, path, deadline=expires, **kwargs)
        self.jobs.workspace_read = read_workspace
        self.env = {"environmentId": "env", "generation": 3, "workspaceId": "ws", "image": "fixed@sha256:" + "1" * 64, "network": "none"}
        self.addCleanup(patch.stopall)
        patch("shell_jobs.boot_id", return_value="boot").start()
        patch.object(time, "CLOCK_BOOTTIME", time.CLOCK_MONOTONIC, create=True).start()

    def request(self, op="op", **arguments):
        ref = {"environmentId": "env", "generation": 3, "fencing": "f", "leaseId": "lease", "workflowId": "workflow"}
        expiry = (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()
        return {"environment": ref, "permit": {**ref, "operationId": op, "attemptId": "attempt", "digest": "digest", "expiresAt": expiry},
                "operationId": op, "attemptId": "attempt", "digest": "digest", "scope": "scope", "deadline": expiry,
                "arguments": {"mode": "start", "argv": ["/bin/true"], "cwd": ".", "env": {}, **arguments}}

    def prepare(self, req):
        return self.jobs.prepare(self.env, req, self.jobs.check(self.env, req))

    def test_gui_budget_preserves_aggregate_and_limits_all_jobs(self):
        for kind, limit in (("tools", "256"), ("gui", "112")):
            self.env["desktopKind"] = kind
            with patch.object(self.jobs, "system") as system:
                self.jobs.configure_environment(self.env)
            calls = [call.args for call in system.call_args_list]
            aggregate = next(call for call in calls if self.jobs.slice(self.env) in call and "set-property" in call)
            jobs = next(call for call in calls if self.jobs.job_slice(self.env) in call and "set-property" in call)
            self.assertIn("TasksMax=512", aggregate)
            self.assertIn("MemoryMax=4G", aggregate)
            self.assertIn("TasksMax=" + limit, jobs)
            _, record, _ = self.prepare(self.request(kind))
            self.assertEqual(record["desktopKind"], kind)
            self.assertIn("--pids-limit=" + limit, container_command(record))

    def test_same_operation_returns_one_immutable_identity_without_extending_deadline(self):
        req = self.request()
        path, record, existing = self.prepare(req)
        self.assertFalse(existing)
        original = (path / "manifest.json").read_bytes()
        renewed = {**req, "permit": {**req["permit"], "expiresAt": (datetime.now(timezone.utc) + timedelta(seconds=120)).isoformat()}}
        renewed["deadline"] = renewed["permit"]["expiresAt"]
        again, other, existing = self.prepare(renewed)
        self.assertTrue(existing)
        self.assertEqual(again, path)
        self.assertEqual(other["monotonicDeadline"], record["monotonicDeadline"])
        self.assertEqual((path / "manifest.json").read_bytes(), original)
        self.assertFalse((self.workspace / ".kaguya-tools").exists())
        self.assertNotIn("permit", record)
        self.assertNotIn("token", record)
        self.assertEqual(record["uid"], 1000)
        conflict = {**req, "arguments": {**req["arguments"], "argv": ["/bin/false"]}}
        with self.assertRaisesRegex(BrokerError, "job-operation-conflict"):
            self.prepare(conflict)

    def test_old_permit_and_mismatched_generation_are_rejected(self):
        req = self.request()
        req["permit"]["expiresAt"] = "2000-01-01T00:00:00Z"
        with self.assertRaisesRegex(BrokerError, "permit-expired"):
            self.jobs.check(self.env, req)
        req = self.request()
        req["permit"]["generation"] = 2
        with self.assertRaisesRegex(BrokerError, "permit-binding-mismatch"):
            self.jobs.check(self.env, req)

    def test_control_environment_injection_and_unsafe_cwd_are_rejected(self):
        for variables in ({"NODE_OPTIONS": "--require /workspace/x"}, {"KAGUYA_TOKEN": "x"}, {"NOTIFY_SOCKET": "/x"}, {"LD_PRELOAD": "/x"}):
            with self.subTest(variables=variables), self.assertRaisesRegex(BrokerError, "invalid-job-environment"):
                self.prepare(self.request(env=variables))
        for cwd in ("/tmp", "../private", "a/../b", ".kaguya-tools"):
            with self.subTest(cwd=cwd), self.assertRaises(BrokerError):
                self.prepare(self.request(cwd=cwd))
        (self.workspace / "link").symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            self.prepare(self.request(cwd="link"))

    def test_scope_and_original_attempt_remain_bound(self):
        req = self.request()
        path, record, _ = self.prepare(req)
        with self.assertRaisesRegex(BrokerError, "job-not-authorized"):
            self.jobs.owned(self.env, {**req, "scope": "other"}, record["jobId"])
        query = self.request("verify", mode="verify", jobId=record["jobId"], original={"operationId": "op", "attemptId": "other"})
        with self.assertRaisesRegex(BrokerError, "original-operation-mismatch"):
            self.jobs.handle(self.env, query)
        self.assertEqual(read_json(path / "manifest.json")["attemptId"], "attempt")

    def test_output_reservations_bound_all_environments(self):
        with patch("shell_jobs.LOG_TOTAL", 2 * LOG_RESERVATION):
            p, _, _ = self.prepare(self.request("one"))
            self.prepare(self.request("two"))
            with self.assertRaisesRegex(BrokerError, "job-output-budget-exhausted"):
                self.prepare(self.request("three"))
            (p / "stdout").write_bytes(b"done")
            write_json(p / "receipt.json", {"state": "exited"})
            with self.assertRaisesRegex(BrokerError, "job-output-budget-exhausted"):
                self.prepare(self.request("three"))
            # 两份完整 reservation 不能再取得第三份；释放足够额度才允许新 job。
            with patch("shell_jobs.LOG_TOTAL", 2 * LOG_RESERVATION + 4):
                self.prepare(self.request("three"))

    def test_startup_without_persistent_group_cannot_confirm_claimed_job(self):
        path, record, _ = self.prepare(self.request())
        self.jobs.properties = lambda _: {"ActiveState": "inactive", "ControlGroup": ""}
        self.jobs.container_info = lambda _: None
        self.assertTrue(self.jobs.unit_empty(record))  # 未 claim，未创建容器。
        (path / "claimed").touch()
        self.assertFalse(self.jobs.unit_empty(record))
        write_json(path / "armed.json", {"bootId": "boot", "unit": record["unit"],
                                        "unitGroup": "/nonexistent-kaguya-test", "invocationId": "one"})
        self.assertTrue(self.jobs.unit_empty(record))  # 没有 running.json，仍核查持久 unit cgroup。
        self.jobs.properties = lambda _: {"ActiveState": "inactive", "InvocationID": "other"}
        self.assertFalse(self.jobs.unit_empty(record))

    def test_expired_armed_job_is_unknown_only_after_isolation(self):
        path, record, _ = self.prepare(self.request())
        (path / "armed.json").touch()
        record["expires"] = time.time() - 1
        self.jobs.unit_empty = lambda _: False
        self.assertEqual(self.jobs.view(path, record)["state"], "prepared")
        self.assertFalse((path / "receipt.json").exists())
        self.jobs.unit_empty = lambda _: True
        retired = []
        self.jobs.retire = lambda p, r: retired.append(r["jobId"])
        result = self.jobs.view(path, record)
        self.assertEqual(result["state"], "unknown")
        self.assertEqual(result["reason"], "supervisor-lost-before-running")
        self.assertIsNone(result["signal"])
        self.assertEqual(retired, [record["jobId"]])

    def test_isolation_does_not_infer_payload_signal(self):
        path, record, _ = self.prepare(self.request())
        self.jobs.finalize(path, record, "stopped", "stop-requested")
        receipt = read_json(path / "receipt.json")
        self.assertTrue(receipt["isolationConfirmed"])
        self.assertIsNone(receipt["signal"])

    def test_legacy_exit_code_does_not_become_payload_status_or_reexecute(self):
        path, record, _ = self.prepare(self.request())
        write_json(path / "receipt.json", {"state": "exited", "exitCode": 128, "signal": None})
        before = (path / "receipt.json").read_bytes()
        view = self.jobs.view(path, record)
        self.assertEqual(view["state"], "unknown")
        self.assertEqual(view["reason"], "legacy-exit-status-unconfirmed")
        self.assertIsNone(view["exitCode"])
        self.assertEqual((path / "receipt.json").read_bytes(), before)
        _, _, existing = self.prepare(self.request())
        self.assertTrue(existing)

    def test_retirement_requires_full_cid_and_matching_private_identity(self):
        path, record, _ = self.prepare(self.request())
        self.jobs.unit_empty = lambda _: True
        cid = "a" * 64
        info = {"Id": cid, "State": {}, "Config": {"Labels": {"kaguya.environment": "env", "kaguya.role": "shell",
                  "kaguya.job": record["jobId"], "kaguya.generation": "3"}}}
        self.jobs.container_info = lambda _: info
        with self.assertRaisesRegex(BrokerError, "container-identity-unconfirmed"):
            self.jobs.retire(path, record)
        (path / "container.cid").write_text("b" * 64)
        with self.assertRaisesRegex(BrokerError, "container-identity-unconfirmed"):
            self.jobs.retire(path, record)
        (path / "container.cid").write_text(cid)
        info["Config"]["Labels"]["kaguya.generation"] = "2"
        with self.assertRaisesRegex(BrokerError, "container-identity-unconfirmed"):
            self.jobs.retire(path, record)
        info["Config"]["Labels"]["kaguya.generation"] = "3"
        commands = []
        self.jobs.backend.command = lambda *args: commands.append(args)
        self.jobs.stopped = lambda _: True
        self.jobs.system = lambda *args, **kwargs: None
        self.jobs.properties = lambda _: {"ActiveState": "inactive"}
        self.jobs.retire(path, record)
        self.assertEqual(commands, [("rm", "--force", cid)])

    def test_runtime_lookup_tracks_private_cid_when_name_lookup_is_empty(self):
        path, record, _ = self.prepare(self.request())
        cid = "c" * 64
        (path / "container.cid").write_text(cid)
        info = {"Id": cid, "State": {"Running": False, "Pid": 0}}
        calls = []
        def command(*args):
            calls.append(args)
            if args[0] == "ps":
                return cid.encode() if "id=" + cid in args else b""
            self.assertEqual(args, ("inspect", cid))
            return json.dumps([info])
        self.jobs.backend.command = command
        self.jobs.unit_empty = lambda _: True
        self.assertEqual(self.jobs.container_info(record), info)
        self.assertFalse(self.jobs.stopped(record))
        self.assertTrue(all("name=" not in str(args) for args in calls))
        self.jobs.backend.command = lambda *args: b""
        self.assertTrue(self.jobs.stopped(record))

    def test_unknown_member_cannot_acknowledge_isolation_from_labels_only(self):
        self.jobs.backend.command = lambda *args: json.dumps([{"Names": ["kaguya-job-" + "a" * 64]}])
        with self.assertRaisesRegex(BrokerError, "unknown-shell-member-isolation-unconfirmed"):
            self.jobs.isolate(self.env)

    def test_file_export_hash_range_and_fifo_rejection(self):
        (self.workspace / "file").write_bytes(b"abcdef")
        result = file_result(self.workspace, "file", 2, 2)
        self.assertEqual(result["sha256"], hashlib.sha256(b"abcdef").hexdigest())
        self.assertEqual(result["dataBase64"], "Y2Q=")
        self.assertEqual(result["size"], 6)
        with self.assertRaisesRegex(BrokerError, "export-hash-mismatch"):
            file_result(self.workspace, "file", expected="0" * 64)
        os.mkfifo(self.workspace / "fifo")
        with self.assertRaisesRegex(BrokerError, "regular-file-required"):
            file_result(self.workspace, "fifo")
        (self.workspace / "link").symlink_to(self.workspace / "file")
        with self.assertRaises(OSError):
            file_result(self.workspace, "link")

    def test_directory_swap_cannot_redirect_open_file_to_private_tree(self):
        folder = self.workspace / "dir"
        folder.mkdir()
        (folder / "file").write_bytes(b"public")
        private = self.root / "secret"
        private.mkdir()
        (private / "file").write_bytes(b"private")
        original_open = os.open
        swapped = False
        def racing_open(path, flags, *args, **kwargs):
            nonlocal swapped
            fd = original_open(path, flags, *args, **kwargs)
            if path == "dir" and not swapped:
                swapped = True
                folder.rename(self.workspace / "moved")
                folder.symlink_to(private, target_is_directory=True)
            return fd
        with patch("shell_jobs.os.open", side_effect=racing_open):
            result = file_result(self.workspace, "dir/file", 0, 20)
        self.assertEqual(result["sha256"], hashlib.sha256(b"public").hexdigest())



class JobProtocolTest(unittest.TestCase):
    def frame(self, seq, kind, **fields):
        return (json.dumps(dict(v=1, seq=seq, kind=kind, **fields)) + "\n").encode()

    def test_explicit_high_exit_codes_and_signal_have_distinct_evidence(self):
        for code in (0, 23, 127, 128, 143, 255):
            protocol = JobProtocol()
            wire = self.frame(0, "exit", code=code)
            for byte in wire:
                self.assertEqual(protocol.feed(bytes([byte])), [])
            result = protocol.outcome(0)
            self.assertEqual(result["exitCode"], code)
            self.assertIsNone(result["signal"])
            self.assertEqual(result["exitStatus"], {"kind": "exit", "code": code})
        protocol = JobProtocol()
        protocol.feed(self.frame(0, "signal", number=15))
        self.assertEqual(protocol.outcome(0)["signal"], "SIGTERM")
        self.assertIsNone(protocol.outcome(0)["exitCode"])
        self.assertEqual(protocol.outcome(137)["state"], "unknown")
        self.assertEqual(protocol.outcome(0, "permit-expired")["exitStatus"], {"kind": "unknown"})

    def test_payload_protocol_lookalikes_stay_output(self):
        fake = self.frame(0, "exit", code=0)
        protocol = JobProtocol()
        self.assertEqual(protocol.feed(self.frame(0, "stdout", data=base64.b64encode(fake).decode())), [("stdout", fake)])
        self.assertEqual(protocol.outcome(0)["state"], "unknown")
        protocol.feed(self.frame(1, "exit", code=23))
        self.assertEqual(protocol.outcome(0)["exitCode"], 23)

    def test_truncated_reordered_duplicate_or_extra_frames_are_not_status(self):
        for wire in (self.frame(1, "exit", code=0), self.frame(0, "exit", code=True),
                     self.frame(0, "signal", number=0), self.frame(0, "stdout", data="!"),
                     self.frame(0, "exit", code=0) * 2, b'x' * 65537):
            with self.subTest(wire=wire[:80]), self.assertRaises(BrokerError):
                JobProtocol().feed(wire)
        protocol = JobProtocol()
        protocol.feed(self.frame(0, "exit", code=0) + b'{')
        self.assertEqual(protocol.outcome(0)["state"], "unknown")
        protocol = JobProtocol()
        protocol.feed(self.frame(0, "unknown", reason="payload-spawn-failed"))
        self.assertEqual(protocol.outcome(0)["state"], "unknown")
        self.assertIsNone(protocol.outcome(0)["exitCode"])


@unittest.skipUnless(os.environ.get("KAGUYA_MONITOR_DOCKER_IMAGE"), "requires explicitly selected existing Linux Docker image with Python")
class LinuxMonitorTest(unittest.TestCase):
    def line(self, stream):
        deadline = time.monotonic() + 15
        data = bytearray()
        with selectors.DefaultSelector() as wait:
            wait.register(stream, selectors.EVENT_READ)
            while not data.endswith(b"\n"):
                self.assertTrue(wait.select(max(0, deadline - time.monotonic())), "monitor barrier timeout")
                value = os.read(stream.fileno(), 1)
                self.assertTrue(value and len(data) < 65536, "monitor barrier closed or oversized")
                data.extend(value)
        return bytes(data)

    def monitor(self, argv, interrupt=False):
        docker = os.environ.get("KAGUYA_MONITOR_DOCKER", "docker")
        name = "kaguya-shell302-monitor-" + uuid.uuid4().hex
        command = [docker, "run", "--rm", "--pull=never", "--name="+name, "--interactive", "--network=none",
                   "--user=1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only",
                   "--pids-limit=64", "--memory=256m", "--tmpfs=/workspace:rw,nosuid,nodev,uid=1000,gid=1000",
                   "--tmpfs=/tmp:rw,nosuid,nodev", "--workdir=/workspace", "--entrypoint=/usr/bin/python3",
                   os.environ["KAGUYA_MONITOR_DOCKER_IMAGE"], "-I", "-c", JOB_MONITOR, ".", '{"PATH":"/usr/bin:/bin"}', *argv]
        try:
            if interrupt:
                process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                try:
                    ready = self.line(process.stdout)
                    self.assertEqual(ready, b"kaguya-job-ready\n")
                    process.stdin.write(b"run\n")
                    process.stdin.close()
                    process.stdin = None
                    entered = self.line(process.stdout)
                    self.assertEqual(JobProtocol().feed(entered), [("stdout", b"entered\n")])
                    subprocess.run([docker, "kill", "--signal=KILL", name], check=True, stdout=subprocess.DEVNULL, timeout=10)
                    output, error = process.communicate(timeout=10)
                    result = subprocess.CompletedProcess(command, process.returncode, ready + entered + output, error)
                finally:
                    if process.poll() is None: process.kill()
                    process.wait(timeout=5)
                    for stream in (process.stdin, process.stdout, process.stderr):
                        if stream: stream.close()
            else:
                result = subprocess.run(command, input=b"run\n", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            self.assertTrue(result.stdout.startswith(b"kaguya-job-ready\n"), result.stderr)
            protocol = JobProtocol()
            output = protocol.feed(result.stdout.removeprefix(b"kaguya-job-ready\n"))
            return protocol.outcome(result.returncode), output
        finally:
            subprocess.run([docker, "rm", "--force", name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)

    def test_real_waitpid_distinguishes_signal_and_exit_128_or_143(self):
        for code in (0, 23, 127, 128, 143, 255):
            with self.subTest(code=code):
                result, _ = self.monitor(["/bin/sh", "-c", "exit " + str(code)])
                self.assertEqual(result["exitStatus"], {"kind": "exit", "code": code})
                self.assertIsNone(result["signal"])
        for number, name in ((15, "SIGTERM"), (9, "SIGKILL")):
            with self.subTest(signal=name):
                result, _ = self.monitor(["/usr/bin/python3", "-c", "import os;os.kill(os.getpid(),"+str(number)+")"])
                self.assertEqual(result["exitStatus"], {"kind": "signal", "number": number})
                self.assertEqual(result["signal"], name)
                self.assertIsNone(result["exitCode"])

    def test_payload_cannot_write_monitor_fds_or_memory_or_forge_terminal(self):
        code = r"""
import os,json,ctypes
assert os.getuid()==1000
assert int(next(x.split()[1] for x in open('/proc/self/status') if x.startswith('CapEff:')),16)==0
for target in ('/proc/1/fd/0','/proc/1/fd/1','/proc/1/fd/2','/proc/1/mem'):
    try: fd=os.open(target,os.O_WRONLY)
    except PermissionError: pass
    else: os.close(fd);raise AssertionError('monitor exposed: '+target)
libc=ctypes.CDLL(None,use_errno=True)
assert libc.ptrace(16,1,0,0)==-1
assert ctypes.get_errno()==1
# 子进程的 stdout/stderr 均经过数据封装；伪造 JSON 只能成为输出。
print(json.dumps(dict(v=1,seq=0,kind='exit',code=0)))
os.write(2,b'actual-stderr')
raise SystemExit(23)
"""
        result, output = self.monitor(["/usr/bin/python3", "-c", code])
        self.assertEqual(result["exitCode"], 23, output)
        self.assertEqual(b"".join(data for kind, data in output if kind == "stderr"), b"actual-stderr")
        self.assertIn(b'"code": 0', b"".join(data for kind, data in output if kind == "stdout"))

    def test_pid_one_reaps_orphans_without_losing_direct_child_signal(self):
        code = r"""
import os,time
for index in range(100):
    pid=os.fork()
    if pid==0:
        if os.fork()==0: os._exit(0)
        os._exit(0)
    os.waitpid(pid,0)
    deadline=time.monotonic()+2
    while True:
        # 父子均已退出后等待 PID 1 回收；不以 sleep 猜测回收已完成。
        states=[]
        for name in os.listdir('/proc'):
            if not name.isdigit(): continue
            try: states.append(open('/proc/'+name+'/stat').read().split()[2])
            except FileNotFoundError: pass
        if 'Z' not in states: break
        assert time.monotonic()<deadline, 'orphan-zombie-not-reaped'
        time.sleep(0.001)
os.kill(os.getpid(),15)
"""
        result, output = self.monitor(["/usr/bin/python3", "-c", code])
        self.assertEqual(result["exitStatus"], {"kind": "signal", "number": 15}, output)

    def test_killed_monitor_and_failed_exec_are_unknown(self):
        result, _ = self.monitor(["/usr/bin/python3", "-c", "import time;print('entered',flush=True);time.sleep(60)"], interrupt=True)
        self.assertEqual(result["state"], "unknown")
        self.assertIsNone(result["exitCode"])
        result, _ = self.monitor(["/does-not-exist"])
        self.assertEqual(result["reason"], "payload-spawn-failed")
        self.assertIsNone(result["exitCode"])

if __name__ == "__main__":
    unittest.main()
