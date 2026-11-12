#!/usr/bin/env python3
"""功能概述：每个 shell job 的可信宿主 supervisor，运行于独立 systemd user service。
主要职责：run 在不可重放 claim 后布置固定截止，核对 payload/conmon 的 cgroup 后放行 argv，
收集有界输出，并在整个 payload cgroup 清空后写回执；停止屏障本身不证明命令收到的信号。systemd 清理崩溃或暂停的 supervisor。
代码库关系：shell_jobs.py 传入私有 manifest；固定 JOB_MONITOR 在容器中保护状态通道，JobProtocol 只解码它的有序回执。
输入输出与副作用：命令没有 permit、控制 FD 或宿主路径；监控器为不可 dump 的 PID 1，子进程只有私有输出管道；失去可信回执保留 unknown。lease renew 不改变原截止。
GUI 环境的单 job 也遵循 112 tasks 上限，其父 jobs slice 限制并发 job 总额。
"""
import base64
import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker import BrokerError, PodmanBackend  # noqa: E402
from shell_jobs import ShellJobs, LOG_RESERVATION, boot_id, file_result, now_iso, read_json, write_json  # noqa: E402



# 固定代码来自受信宿主，不从 workspace 导入。PID 1 独占传输 FD，不插入另一个 init；
# PR_SET_DUMPABLE=0 拒绝同 UID 命令通过 /proc、ptrace 或 process_vm_writev 改写状态。
JOB_MONITOR = r"""
import base64, ctypes, json, os, selectors, signal, subprocess, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(4, 0, 0, 0, 0) != 0 or libc.prctl(3, 0, 0, 0, 0) != 0:
    raise RuntimeError('monitor-protection-unconfirmed')
seq = 0
def emit(kind, **fields):
    global seq
    data = (json.dumps(dict(v=1, seq=seq, kind=kind, **fields), separators=(',', ':'))+'\n').encode()
    seq += 1
    while data:
        written = os.write(1, data)
        if written <= 0: raise RuntimeError('status-transport-lost')
        data = data[written:]
os.write(1, b'kaguya-job-ready\n')
if sys.stdin.buffer.read(5) != b'run\n': raise RuntimeError('invalid-start-gate')
cwd, variables, command, *args = sys.argv[1:]
if not command.startswith('/'): raise RuntimeError('absolute-command-required')
fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for part in [] if cwd == '.' else cwd.split('/'):
        if not part or part in ('.', '..', '.kaguya-tools'): raise RuntimeError('unsafe-cwd')
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        os.close(fd)
        fd = child
    os.fchdir(fd)
finally:
    os.close(fd)
try:
    child = subprocess.Popen([command, *args], env=json.loads(variables), stdin=subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True)
except OSError:
    emit('unknown', reason='payload-spawn-failed')
else:
    # PID 1 同时回收被收养的后代；单一 waitpid 路径保留直接 child 的真实状态。
    reaping = False
    def reap(*unused):
        global reaping
        if reaping: return
        reaping = True
        try:
            while True:
                try: pid, status = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError: break
                if not pid: break
                if pid == child.pid:
                    child.returncode = -os.WTERMSIG(status) if os.WIFSIGNALED(status) else os.WEXITSTATUS(status)
        finally:
            reaping = False
    signal.signal(signal.SIGCHLD, reap)
    reap()
    with selectors.DefaultSelector() as selector:
        for stream, kind in ((child.stdout, 'stdout'), (child.stderr, 'stderr')):
            selector.register(stream, selectors.EVENT_READ, kind)
        while selector.get_map():
            reap()
            for key, _ in selector.select(0.1):
                data = os.read(key.fileobj.fileno(), 32768)
                if data: emit(key.data, data=base64.b64encode(data).decode('ascii'))
                else:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
    while child.returncode is None:
        reap()
        if child.returncode is None: __import__('time').sleep(0.01)
    code = child.returncode
    if code < 0: emit('signal', number=-code)
    else: emit('exit', code=code)
"""


class JobProtocol:
    """只接收监控器 stdout；payload 字节只作为有界 base64 数据，不参与状态解析。"""
    def __init__(self):
        self.buffer = bytearray()
        self.sequence = 0
        self.terminal = None

    def feed(self, data):
        self.buffer.extend(data)
        output = []
        while b"\n" in self.buffer:
            line, _, rest = self.buffer.partition(b"\n")
            self.buffer = bytearray(rest)
            if self.terminal is not None or len(line) > 65536:
                raise BrokerError("invalid-job-status-frame")
            try:
                frame = json.loads(line)
                if (not isinstance(frame, dict) or frame.get("v") != 1 or
                        type(frame.get("seq")) is not int or frame["seq"] != self.sequence):
                    raise ValueError()
                kind = frame.get("kind")
                keys = {"v", "seq", "kind"}
                if kind in ("stdout", "stderr") and set(frame) == keys | {"data"}:
                    value = base64.b64decode(frame["data"], validate=True)
                    if not 0 < len(value) <= 32768: raise ValueError()
                    output.append((kind, value))
                elif kind == "exit" and set(frame) == keys | {"code"} and type(frame["code"]) is int and 0 <= frame["code"] <= 255:
                    self.terminal = {"kind": "exit", "code": frame["code"]}
                elif kind == "signal" and set(frame) == keys | {"number"} and type(frame["number"]) is int and 1 <= frame["number"] <= 64:
                    self.terminal = {"kind": "signal", "number": frame["number"]}
                elif kind == "unknown" and set(frame) == keys | {"reason"} and frame["reason"] == "payload-spawn-failed":
                    self.terminal = {"kind": "unknown", "reason": frame["reason"]}
                else:
                    raise ValueError()
            except (ValueError, TypeError, KeyError):
                raise BrokerError("invalid-job-status-frame") from None
            self.sequence += 1
        if len(self.buffer) > 65536:
            raise BrokerError("invalid-job-status-frame")
        return output

    def outcome(self, transport_code, reason=None):
        status = self.terminal
        if reason or transport_code != 0 or self.buffer or status is None:
            return {"state": "stopped" if reason else "unknown", "exitCode": None, "signal": None,
                    "exitStatus": {"kind": "unknown"}, "reason": reason or "job-status-unconfirmed"}
        if status["kind"] == "unknown":
            return {"state": "unknown", "exitCode": None, "signal": None, "exitStatus": status,
                    "reason": status["reason"]}
        number = status.get("number")
        try:
            name = signal.Signals(number).name if number else None
        except ValueError:
            name = "SIG" + str(number)
        return {"state": "exited", "exitCode": status.get("code"), "signal": name, "exitStatus": status}

def remaining(record):
    return min(record["expires"] - time.time(), record["monotonicDeadline"] - time.monotonic(),
               record["bootDeadline"] - time.clock_gettime(time.CLOCK_BOOTTIME))


def group_for(pid):
    lines = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
    return next(line[3:] for line in lines if line.startswith("0::"))


def payload_empty(group):
    path = Path("/sys/fs/cgroup") / group.lstrip("/") / "cgroup.events"
    return not path.exists() or "populated 0" in path.read_text()


def read_gate(proc, deadline):
    ready = bytearray()
    with selectors.DefaultSelector() as handshake:
        handshake.register(proc.stdout, selectors.EVENT_READ)
        while not ready.endswith(b"\n"):
            if not handshake.select(max(0, deadline - time.monotonic())):
                raise BrokerError("gate-ready-timeout")
            data = os.read(proc.stdout.fileno(), 1)
            if not data or len(ready) >= 128:
                raise BrokerError("gate-ready-invalid")
            ready.extend(data)
    if ready != b"kaguya-job-ready\n":
        raise BrokerError("gate-ready-invalid")


def container_command(record, cidfile=None):
    command = ["/usr/bin/podman", "--cgroup-manager=cgroupfs", "run", "--pull=never", "--interactive",
               "--name=" + record["container"], "--label=kaguya.environment=" + record["environmentId"],
               "--label=kaguya.role=shell", "--label=kaguya.job=" + record["jobId"],
               "--label=kaguya.generation=" + str(record["generation"]), "--cgroups=split",
               "--userns=keep-id:uid=1000,gid=1000", "--user=1000:1000", "--cap-drop=ALL",
               "--security-opt=no-new-privileges", "--read-only", "--ipc=private", "--pid=private",
               "--cgroupns=private", "--cpus=1", "--memory=2g", "--memory-swap=2g", "--pids-limit=" + ("112" if record.get("desktopKind") == "gui" else "256"),
               "--shm-size=512m", "--log-driver=none", "--restart=no",
               "--network=" + ("none" if record["network"] == "none" else "pasta:--no-map-gw"),
               "--tmpfs=/tmp:rw,nosuid,nodev,size=512m", "--tmpfs=/run:rw,nosuid,nodev,size=64m",
               "--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,mode=0700,U",
               "--volume=" + record["volume"] + ":/workspace:rw", "--workdir=/workspace",
               "--entrypoint=/usr/bin/python3"]
    if cidfile is not None:
        command += ["--cidfile=" + str(cidfile)]
    command += ["--env=PATH=/usr/local/bin:/usr/bin:/bin", "--env=HOME=/home/tool", "--env=TMPDIR=/tmp", "--env=LANG=C.UTF-8"]
    command += [record["image"], "-I", "-c", JOB_MONITOR, record["cwd"], json.dumps(record["env"]), *record["argv"]]
    return command


def run(path):
    record = read_json(path / "manifest.json")
    if record["bootId"] != boot_id() or remaining(record) <= 0:
        raise BrokerError("job-expired-before-launch")
    lock = os.open(path / "runner.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # claim 永不删除；重复 unit start 以及恢复均不得再次执行命令。
    claim = os.open(path / "claimed", os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    os.fsync(claim)
    os.close(claim)
    directory = os.open(path, os.O_DIRECTORY | os.O_RDONLY)
    os.fsync(directory)
    os.close(directory)
    backend = PodmanBackend()
    backend.env = record["hostEnv"]
    jobs = ShellJobs(path.parent.parent, backend)
    props = jobs.properties(record["unit"])
    group = props["ControlGroup"]
    if not group or group_for(os.getpid()) != group:
        raise BrokerError("supervisor-cgroup-unconfirmed")
    if not props.get("InvocationID"):
        raise BrokerError("supervisor-invocation-unconfirmed")
    # 在创建任何 OCI 进程之前持久化整个 unit 的归属，覆盖 gate 尚未 ready 的崩溃窗口。
    write_json(path / "armed.json", {"bootId": record["bootId"], "unit": record["unit"],
                                    "invocationId": props["InvocationID"], "unitGroup": group}, exclusive=True)
    # 已启动服务的 RuntimeMaxUSec 在 systemd 255 不可修改。使用机器启动时间为
    # 固定原点的 timer，不能用 OnActiveSec 把 supervisor 启动排队耗时变成续权。
    expiry_unit = record["unit"].removesuffix(".service") + "-expiry"
    jobs.system("/usr/bin/systemd-run", "--user", "--quiet", "--unit=" + expiry_unit,
                f"--on-boot={record['monotonicDeadline']:.6f}s",
                "--on-calendar=" + datetime.fromtimestamp(record["expires"], timezone.utc).strftime("%Y-%m-%d %H:%M:%S.%f UTC"),
                "--timer-property=AccuracySec=1us",
                "--timer-property=RandomizedDelaySec=0", "/usr/bin/systemctl", "--user", "stop", record["unit"])
    timer_path = jobs.system("/usr/bin/busctl", "--user", "call", "org.freedesktop.systemd1",
                            "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager",
                            "GetUnit", "s", expiry_unit + ".timer").stdout.decode().split(" ", 1)[1]
    timer_path = json.loads(timer_path)
    next_elapse = jobs.system("/usr/bin/busctl", "--user", "get-property", "org.freedesktop.systemd1", timer_path,
                             "org.freedesktop.systemd1.Timer", "NextElapseUSecMonotonic").stdout.decode()
    armed_deadline = int(next_elapse.split()[1]) / 1000000
    if (jobs.properties(expiry_unit + ".timer").get("ActiveState") != "active" or
            not 0 < armed_deadline <= record["monotonicDeadline"] + 0.000002 or remaining(record) <= 0):
        raise BrokerError("deadline-not-armed")
    command = container_command(record, path / "container.cid")
    streams = {}
    proc = None
    selector = selectors.DefaultSelector()
    reason, payload_group, count = None, None, 0
    protocol = JobProtocol()
    try:
        for name in ("stdout", "stderr"):
            streams[name] = os.open(path / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        proc = subprocess.Popen(command, env=backend.env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        end = time.monotonic() + min(15, remaining(record))
        read_gate(proc, end)
        while time.monotonic() < end:
            if proc.poll() is not None:
                os.write(streams["stderr"], proc.stderr.read(LOG_RESERVATION))
                raise BrokerError("container-start-failed")
            result = subprocess.run(["/usr/bin/podman", "inspect", record["container"]], env=backend.env,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=2)
            if result.returncode == 0:
                info = json.loads(result.stdout)[0]
                pid = info["State"].get("Pid", 0)
                if info["State"]["Running"] and pid:
                    cid = (path / "container.cid").read_text().strip()
                    if info["Id"] != cid:
                        raise BrokerError("container-identity-unconfirmed")
                    with open(path / "container.cid", "rb") as cid_source:
                        os.fsync(cid_source.fileno())
                    payload_group = group_for(pid)
                    conmon_group = group_for(info["State"]["ConmonPid"])
                    if not all(g.startswith(group + "/") for g in (payload_group, conmon_group)):
                        raise BrokerError("container-outside-job-unit")
                    if remaining(record) <= 0:
                        raise BrokerError("permit-expired-before-release")
                    write_json(path / "running.json", {"pidNamespace": os.readlink(f"/proc/{pid}/ns/pid"),
                                                       "payloadGroup": payload_group, "unitGroup": group,
                                                       "conmonGroup": conmon_group, "containerId": info["Id"],
                                                       "supervisorPid": os.getpid(), "deadlineArmed": True,
                                                       "armedMonotonicDeadline": armed_deadline, "timerUnit": expiry_unit + ".timer"})
                    proc.stdin.write(b"run\n")
                    proc.stdin.close()
                    break
            time.sleep(0.02)
        else:
            raise BrokerError("container-start-timeout")
        for stream, name in ((proc.stdout, "stdout"), (proc.stderr, "stderr")):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        while selector.get_map():
            left = remaining(record)
            if left <= 0:
                reason = "permit-expired"
                break
            for key, _ in selector.select(min(left, 0.1)):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                # stdout 仅是受信监控协议；Podman/监控器自身 stderr 留作诊断。
                chunks = protocol.feed(data) if key.data == "stdout" else [("stderr", data)]
                for name, chunk in chunks:
                    if count + len(chunk) > LOG_RESERVATION:
                        reason = "job-output-budget-exhausted"
                        break
                    with memoryview(chunk) as view:
                        while view:
                            written = os.write(streams[name], view)
                            view = view[written:]
                    count += len(chunk)
                if reason:
                    break
            if reason:
                break
        if reason:
            backend.stop_container(record["container"])
        code = proc.wait(timeout=5)
        backend.stop_container(record["container"])
        if not payload_group or not payload_empty(payload_group):
            raise BrokerError("payload-isolation-unconfirmed")
        for fd in streams.values():
            os.fsync(fd)
        receipt = {**protocol.outcome(code, reason), "completedAt": now_iso(), "isolationConfirmed": True}
        if reason:
            receipt["reason"] = reason
        for name in streams:
            receipt[name] = file_result(path, name)
        write_json(path / "receipt.json", receipt)
    finally:
        selector.close()
        try:
            backend.stop_container(record["container"])
        finally:
            jobs.system("/usr/bin/systemctl", "--user", "stop", expiry_unit + ".timer", check=False)
            for fd in streams.values():
                os.close(fd)
            if proc:
                if proc.poll() is None:
                    proc.kill()
                proc.wait(timeout=5)
                for stream in (proc.stdin, proc.stdout, proc.stderr):
                    stream.close()
            os.close(lock)


if __name__ == "__main__":
    try:
        run(Path(sys.argv[1]))
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        if hasattr(error, "diagnostic"):
            print(json.dumps(error.diagnostic), file=sys.stderr)
        sys.exit(1)
