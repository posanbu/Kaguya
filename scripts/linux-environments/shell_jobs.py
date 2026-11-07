"""功能概述：宿主可信 shell 控制面；任意命令只在独立 rootless 容器中执行。
主要职责：ShellJobs 持久登记原 operation/attempt，调度独立 systemd job unit，
核对停止屏障，提供 start/query/stop/verify/export；文件读取保留逐级目录 FD。
代码库关系：PodmanBackend 路由 shell.exec；job_runner.py 独占运行回执，
本模块只在 unit 和整个 cgroup 已停止后补写终态，不与 supervisor 并发写 receipt；隔离证明不推断信号，旧回执没有可信 exitStatus 时以 unknown 展示。
输入输出与副作用：私有宿主目录保存 manifest/日志，只有 workspace 命名卷进入容器。
启动声明一旦落盘就不重放；截止时间固定，未知状态必须隔离后核对，不恢复执行。
GUI 桌面占用 384 tasks 时，全部 shell jobs 共用 112 tasks；环境总额仍为 512 tasks/4G。
"""
import base64
from datetime import datetime, timezone
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time

# -I 的宿主只读辅助进程只恢复 root 拥有的安装目录。
sys.path.insert(0, str(Path(__file__).resolve().parent))
from broker import BrokerError, atomic, canonical, digest

LIMIT = 16 * 1024 ** 2
LOG_RESERVATION = 32 * 1024 ** 2
LOG_TOTAL = 1024 ** 3
MIMES = {"image/png", "image/jpeg", "image/webp", "text/plain", "text/csv", "application/json",
         "application/pdf", "application/zip", "application/octet-stream", "video/webm"}
TERMINAL = {"exited", "stopped", "unknown"}


class SystemCommandError(BrokerError):
    def __init__(self, args, result):
        super().__init__("systemd-job-command-failed")
        self.diagnostic = {"command": args, "exitCode": result.returncode,
                           "stderr": result.stderr.decode(errors="replace")[:4096]}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value, exclusive=False):
    atomic(Path(path), canonical(value).encode(), exclusive=exclusive)


def read_json(path):
    with open(path, "rb") as source:
        return json.load(source)


def boot_id():
    return Path("/proc/sys/kernel/random/boot_id").read_text().strip()


def parts(path, directory=False):
    if directory and path == ".":
        return []
    if not isinstance(path, str) or not path or len(path) > 4096:
        raise BrokerError("workspace-relative-path-required")
    result = path.split("/")
    if any(p in ("", ".", "..", ".kaguya-tools") or "\\" in p or "\0" in p for p in result):
        raise BrokerError("workspace-path-denied")
    return result


def open_beneath(root, path, directory=False):
    components = parts(path, directory)
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for i, component in enumerate(components):
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
            if directory or i < len(components) - 1:
                flags |= os.O_DIRECTORY
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def file_result(root, path, offset=0, length=0, expected=None, deadline=None):
    if type(offset) is not int or offset < 0 or type(length) is not int or not 0 <= length <= LIMIT:
        raise BrokerError("invalid-export-range")
    with os.fdopen(open_beneath(root, path), "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise BrokerError("regular-file-required")
        h = hashlib.sha256()
        while chunk := source.read(1024 ** 2):
            if deadline is not None and time.time() >= deadline:
                raise BrokerError("permit-expired")
            h.update(chunk)
        source.seek(offset)
        data = source.read(length)
        after = os.fstat(source.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise BrokerError("file-changed-during-read")
        sha = h.hexdigest()
        if expected is not None and expected != sha:
            raise BrokerError("export-hash-mismatch")
        result = {"size": before.st_size, "sha256": sha}
        if length:
            result.update(offset=offset, bytes=len(data), partSha256=hashlib.sha256(data).hexdigest(),
                          dataBase64=base64.b64encode(data).decode())
        return result


def success(result, artifacts=None, truncated=False):
    return {"status": "succeeded", "evidence": "returned", "result": result,
            "artifacts": artifacts or [], "truncated": truncated}


class ShellJobs:
    def __init__(self, root, backend):
        self.root = Path(root) / "shell-jobs"
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.backend = backend

    def system(self, *args, timeout=20, check=True):
        result = subprocess.run(args, env=self.backend.env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if check and result.returncode:
            raise SystemCommandError(args, result)
        return result

    def properties(self, unit):
        result = self.system("/usr/bin/systemctl", "--user", "show", unit,
                             "--property=LoadState,ActiveState,SubState,ControlGroup,InvocationID,MainPID,Result,ActiveEnterTimestampMonotonic,RuntimeMaxUSec",
                             check=False)
        props = dict(line.split("=", 1) for line in result.stdout.decode().splitlines() if "=" in line)
        if result.returncode and props.get("LoadState") != "not-found":
            raise BrokerError("systemd-state-unconfirmed")
        return props

    def configure_environment(self, env):
        # 动态 slice 的限制覆盖桌面、全部 job 以及各自 conmon，而非每个容器重复领取总额。
        name = self.slice(env)
        self.system("/usr/bin/systemctl", "--user", "set-property", "--runtime", "kaguya.slice",
                    "CPUQuota=400%", "MemoryMax=10G", "MemorySwapMax=0", "TasksMax=1200")
        self.system("/usr/bin/systemctl", "--user", "set-property", "--runtime", name,
                    "CPUQuota=200%", "MemoryMax=4G", "MemorySwapMax=0", "TasksMax=512")
        self.system("/usr/bin/systemctl", "--user", "start", name)
        self.system("/usr/bin/systemctl", "--user", "set-property", "--runtime", self.job_slice(env),
                    "CPUQuota=100%", "MemoryMax=2G", "MemorySwapMax=0", "TasksMax=" + ("112" if env.get("desktopKind") == "gui" else "256"))
        self.system("/usr/bin/systemctl", "--user", "start", self.job_slice(env))
        return name

    @staticmethod
    def slice(env):
        return "kaguya-e" + digest(env["environmentId"])[:24] + ".slice"

    @classmethod
    def job_slice(cls, env):
        return cls.slice(env).removesuffix(".slice") + "-jobs.slice"

    def records(self, env=None):
        for path in sorted(self.root.glob("*/manifest.json")):
            record = read_json(path)
            if env is None or record["environmentId"] == env["environmentId"]:
                yield path.parent, record

    def workspace(self, env):
        volume = "kaguya-workspace-" + digest(env["workspaceId"])[:24]
        info = json.loads(self.backend.command("volume", "inspect", volume))[0]
        return info["Mountpoint"]

    def workspace_read(self, env, path, expires, *, directory=False, offset=0, length=0, expected=None):
        parts(path, directory)
        # keep-id 的 storage 元数据可能由 subordinate UID 拥有。只读程序在 Podman
        # 自己的 rootless userns 中保留逐级 FD；不放宽宿主目录权限，不执行 workspace 代码。
        args = {"root": self.workspace(env), "path": path, "directory": directory,
                "offset": offset, "length": length, "expected": expected, "deadline": min(expires, time.time() + 20)}
        result = subprocess.run(["/usr/bin/podman", "unshare", "/usr/bin/python3", "-I", str(Path(__file__).resolve()), canonical(args)],
                                env=self.backend.env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, timeout=max(0.1, args["deadline"] - time.time() + 1))
        if result.returncode:
            raise BrokerError("unsafe-workspace-read")
        return json.loads(result.stdout)

    def check(self, env, req):
        p, e = req["permit"], req["environment"]
        for key in ("environmentId", "generation", "fencing", "leaseId", "workflowId"):
            if p.get(key) != e.get(key):
                raise BrokerError("permit-binding-mismatch")
        for key in ("operationId", "attemptId", "digest"):
            if p.get(key) != req.get(key):
                raise BrokerError("permit-operation-mismatch")
        expires = datetime.fromisoformat(p["expiresAt"].replace("Z", "+00:00")).timestamp()
        deadline = datetime.fromisoformat(req["deadline"].replace("Z", "+00:00")).timestamp()
        if e["environmentId"] != env["environmentId"] or e["generation"] != env["generation"]:
            raise BrokerError("stale-environment")
        if expires <= time.time() or expires > deadline:
            raise BrokerError("permit-expired")
        return expires

    def handle(self, env, req):
        expires = self.check(env, req)
        a = req["arguments"]
        if a.get("mode") == "start":
            return self.start(env, req, expires)
        if a.get("mode") in ("query", "stop"):
            path, record = self.owned(env, req, a.get("jobId"))
            if a["mode"] == "stop":
                self.stop(path, record, "stop-requested")
            return success(self.view(path, record))
        if a.get("mode") == "verify":
            original = a.get("original")
            if not isinstance(original, dict) or not all(isinstance(original.get(k), str) for k in ("operationId", "attemptId")):
                raise BrokerError("original-operation-required")
            if a.get("jobId"):
                path, record = self.owned(env, req, a["jobId"])
                if any(record[k] != original[k] for k in ("operationId", "attemptId")):
                    raise BrokerError("original-operation-mismatch")
                return success({"original": original, "checkedAt": now_iso(), "job": self.view(path, record)})
            result = self.workspace_read(env, a.get("path"), expires)
            return success({"original": original, "checkedAt": now_iso(), "verificationKind": "current-file-state",
                            "path": a["path"], **result})
        if a.get("mode") == "export":
            root, path = None, a.get("path")
            if a.get("jobId"):
                root, record = self.owned(env, req, a["jobId"])
                self.view(root, record)
                if a.get("stream") not in ("stdout", "stderr"):
                    raise BrokerError("invalid-job-stream")
                path = a["stream"]
            mime = a.get("mime", "application/octet-stream")
            if mime not in MIMES:
                raise BrokerError("invalid-export-mime")
            if root is None:
                result = self.workspace_read(env, path, expires, offset=a.get("offset", 0),
                                             length=a.get("maxBytes", LIMIT), expected=a.get("sha256"))
            else:
                result = file_result(root, path, a.get("offset", 0), a.get("maxBytes", LIMIT), a.get("sha256"), expires)
            data = result.pop("dataBase64", "")
            return success({"exports": [{"path": a.get("path"), "jobId": a.get("jobId"),
                                         "stream": a.get("stream"), **result}]},
                           [{"mime": mime, "dataBase64": data}], result.get("offset", 0) > 0 or result.get("bytes", 0) < result["size"])
        raise BrokerError("shell-mode-not-supported")

    def owned(self, env, req, job_id):
        if not isinstance(job_id, str) or not re.fullmatch("[a-f0-9]{64}", job_id):
            raise BrokerError("invalid-job-id")
        path = self.root / job_id
        try:
            record = read_json(path / "manifest.json")
        except FileNotFoundError:
            raise BrokerError("job-not-authorized") from None
        if record["environmentId"] != env["environmentId"] or record["scope"] != req["scope"]:
            raise BrokerError("job-not-authorized")
        return path, record

    def start(self, env, req, expires):
        # 不同 environment 的线程共用日志总额；锁覆盖预留和 manifest 发布，而非执行等待。
        with open(self.root / "admission.lock", "a+b") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            path, record, existing = self.prepare(env, req, expires)
        if existing:
            view = self.view(path, record)
            return success({"accepted": view["state"] != "prepared", **view})
        return self.launch(path, record)

    def prepare(self, env, req, expires):
        a = req["arguments"]
        argv = a.get("argv")
        if (not isinstance(argv, list) or not 1 <= len(argv) <= 128 or
                any(not isinstance(v, str) or len(v) > 32768 or "\0" in v for v in argv) or not argv[0].startswith("/")):
            raise BrokerError("invalid-argv")
        cwd = a.get("cwd", ".")
        self.workspace_read(env, cwd, expires, directory=True)
        variables = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/home/tool", "TMPDIR": "/tmp"}
        if not isinstance(a.get("env", {}), dict):
            raise BrokerError("invalid-job-environment")
        for key, value in a.get("env", {}).items():
            if (not re.fullmatch("[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) or "\0" in value or
                    re.match("^(KAGUYA_|NODE_|LD_|DYLD_|NOTIFY_SOCKET$|WATCHDOG_|LISTEN_)", key)):
                raise BrokerError("invalid-job-environment")
            variables[key] = value
        job_id = hashlib.sha256((env["environmentId"] + "\0" + req["operationId"]).encode()).hexdigest()
        request_hash = digest({k: req[k] for k in ("operationId", "attemptId", "digest", "scope", "environment", "arguments")})
        path = self.root / job_id
        if (path / "manifest.json").exists():
            record = read_json(path / "manifest.json")
            if record["requestHash"] != request_hash:
                raise BrokerError("job-operation-conflict")
            return path, record, True
        reserved = sum(LOG_RESERVATION if not (p / "receipt.json").exists() else
                       sum((p / stream).stat().st_size for stream in ("stdout", "stderr") if (p / stream).exists())
                       for p, _ in self.records())
        if reserved + LOG_RESERVATION > LOG_TOTAL:
            raise BrokerError("job-output-budget-exhausted")
        path.mkdir(mode=0o700, exist_ok=True)
        left = expires - time.time()
        if left <= 0:
            raise BrokerError("permit-expired")
        record = {"jobId": job_id, "requestHash": request_hash, "environmentId": env["environmentId"],
                  "generation": env["generation"], "fencing": req["environment"]["fencing"],
                  "leaseId": req["environment"]["leaseId"], "workflowId": req["environment"]["workflowId"],
                  "scope": req["scope"], "operationId": req["operationId"], "attemptId": req["attemptId"],
                  "digest": req["digest"], "state": "prepared", "cwd": cwd,
                  "permitExpiresAt": req["permit"]["expiresAt"], "expires": expires,
                  "monotonicDeadline": time.monotonic() + left,
                  "bootDeadline": time.clock_gettime(time.CLOCK_BOOTTIME) + left, "bootId": boot_id(),
                  "startedAt": now_iso(), "uid": 1000, "gid": 1000, "exitCode": None, "signal": None,
                  "unit": "kaguya-job-" + job_id + ".service", "container": "kaguya-job-" + job_id,
                  "slice": self.job_slice(env), "image": env["image"], "network": env["network"],
                  "desktopKind": env.get("desktopKind", "tools"),
                  "volume": "kaguya-workspace-" + digest(env["workspaceId"])[:24],
                  "argv": argv, "env": variables, "hostEnv": self.backend.env}
        write_json(path / "manifest.json", record, exclusive=True)
        return path, record, False

    def unit_command(self, path, record):
        expires = record["expires"]
        left = min(expires - time.time(), record["monotonicDeadline"] - time.monotonic())
        if left <= 0:
            raise BrokerError("permit-expired")
        runner = str(Path(__file__).with_name("job_runner.py"))
        command = ["/usr/bin/systemd-run", "--user", "--quiet", "--unit=" + record["unit"],
                   "--slice=" + record["slice"], "--service-type=exec", "--property=Delegate=yes",
                   "--property=KillMode=control-group", "--property=KillSignal=SIGKILL", "--property=Restart=no",
                   "--property=TimeoutStopSec=5s", "--property=RuntimeMaxSec=" + str(left) + "s",
                   "--property=UMask=0077", "--property=StandardOutput=null", "--property=StandardError=journal"]
        command += ["--setenv=" + k + "=" + v for k, v in self.backend.env.items()]
        return [*command, "/usr/bin/python3", "-I", runner, str(path)]

    def launch(self, path, record):
        expires = record["expires"]
        self.system(*self.unit_command(path, record))
        end = min(expires, time.time() + 20)
        while time.time() < end:
            if (path / "running.json").exists() or (path / "receipt.json").exists():
                return success({"accepted": True, **self.view(path, record)})
            state = self.properties(record["unit"])
            if state.get("ActiveState") in ("inactive", "failed"):
                self.stop(path, record, "start-unconfirmed")
                raise BrokerError("job-start-unconfirmed")
            time.sleep(0.02)
        self.stop(path, record, "start-unconfirmed")
        raise BrokerError("job-start-unconfirmed")

    def unit_empty(self, record):
        props = self.properties(record["unit"])
        if props.get("ActiveState") not in ("inactive", "failed"):
            return False
        path = self.root / record["jobId"]
        armed = path / "armed.json"
        if not armed.exists():
            # 没有 claim 的 runner 尚未进入创建容器阶段；已 claim 却缺失归属证据时拒绝 ACK。
            return not (path / "claimed").exists() and not self.container_info(record)
        identity = read_json(armed)
        if (identity.get("bootId") != record["bootId"] or identity.get("unit") != record["unit"] or
                not identity.get("invocationId") or not identity.get("unitGroup")):
            return False
        if record["bootId"] != boot_id():
            return True  # 上一次启动的进程已消失；禁止跨启动自动重放。
        if props.get("InvocationID") and props["InvocationID"] != identity["invocationId"]:
            return False
        groups = [identity["unitGroup"], props.get("ControlGroup")]
        running = path / "running.json"
        if running.exists():
            groups.extend(read_json(running)[k] for k in ("unitGroup", "payloadGroup", "conmonGroup"))
        for group in filter(None, groups):
            events = Path("/sys/fs/cgroup") / group.lstrip("/") / "cgroup.events"
            if events.exists() and "populated 0" not in events.read_text().splitlines():
                return False
        return True

    def retire(self, path, record):
        if not self.unit_empty(record):
            raise BrokerError("job-cgroup-still-populated")
        # conmon 被整组终止后，旧 Podman 可留下 stopped + 非零缓存 PID。
        # 先取得 kernel 空组证据，再删除该 job 的 runtime 记录；命名卷/manifest/输出均保留。
        info = self.container_info(record)
        if info:
            cid = (path / "container.cid").read_text().strip() if (path / "container.cid").exists() else None
            running = read_json(path / "running.json") if (path / "running.json").exists() else {}
            labels = info.get("Config", {}).get("Labels", {})
            expected = {"kaguya.environment": record["environmentId"], "kaguya.role": "shell",
                        "kaguya.job": record["jobId"], "kaguya.generation": str(record["generation"])}
            if (not cid or not re.fullmatch("[a-f0-9]{64}", cid) or info["Id"] != cid or
                    running.get("containerId", cid) != cid or any(labels.get(k) != v for k, v in expected.items())):
                raise BrokerError("container-identity-unconfirmed")
            write_json(path / "retired.json", {"containerId": cid, "observedState": info["State"],
                                               "unitCgroupEmpty": True, "checkedAt": now_iso()})
            self.backend.command("rm", "--force", cid)
        if not self.stopped(record):
            raise BrokerError("job-isolation-unconfirmed")
        expiry = record["unit"].removesuffix(".service") + "-expiry"
        for unit in (expiry + ".timer", expiry + ".service"):
            self.system("/usr/bin/systemctl", "--user", "stop", unit, check=False)
            if self.properties(unit).get("ActiveState") not in ("inactive", "failed"):
                raise BrokerError("deadline-unit-cleanup-unconfirmed")
        self.system("/usr/bin/systemctl", "--user", "reset-failed", record["unit"], expiry + ".service", check=False)

    def container_info(self, record):
        cidfile = self.root / record["jobId"] / "container.cid"
        if cidfile.exists():
            identity = cidfile.read_text().strip()
            if not re.fullmatch("[a-f0-9]{64}", identity):
                raise BrokerError("container-identity-unconfirmed")
            selector = "id=" + identity
        else:
            # cidfile 尚未发布时仅用于证明没有创建对象；若发现同名对象，retire 拒绝缺 CID。
            identity = record["container"]
            selector = "name=^" + identity + "$"
        exists = self.backend.command("ps", "--all", "--filter", selector, "--format={{.ID}}").strip()
        return json.loads(self.backend.command("inspect", identity))[0] if exists else None

    def stopped(self, record):
        return self.unit_empty(record) and self.container_info(record) is None

    def stop(self, path, record, reason):
        # 新旧代次都按不可变 job 成员身份停止；不通过用户输入构造 unit 或容器名。
        write_json(path / "stop.json", {"reason": reason})
        self.system("/usr/bin/systemctl", "--user", "stop", record["unit"], check=False)
        end = time.monotonic() + 10
        while not self.unit_empty(record):
            if time.monotonic() >= end:
                raise BrokerError("job-isolation-unconfirmed")
            time.sleep(0.02)
        self.retire(path, record)
        if not (path / "receipt.json").exists():
            self.finalize(path, record, "stopped", reason)

    def finalize(self, path, record, state, reason):
        receipt = {"state": state, "reason": reason, "completedAt": now_iso(), "exitCode": None,
                   "signal": None, "exitStatus": {"kind": "unknown"}, "isolationConfirmed": True}
        for stream in ("stdout", "stderr"):
            if (path / stream).exists():
                receipt[stream] = file_result(path, stream)
        write_json(path / "receipt.json", receipt)

    def view(self, path, record):
        view = {k: record[k] for k in ("jobId", "environmentId", "generation", "workflowId", "scope", "operationId",
                                      "attemptId", "digest", "state", "cwd", "permitExpiresAt", "startedAt", "uid", "gid", "exitCode", "signal")}
        if (path / "receipt.json").exists():
            view.update(read_json(path / "receipt.json"))
        elif (not (path / "running.json").exists()
              and time.time() >= record["expires"] and self.unit_empty(record)):
            # 已过期且持久 unit cgroup 已空，无法证明启动或退出，绝不重放。
            self.retire(path, record)
            self.finalize(path, record, "unknown", "supervisor-lost-before-running")
            view.update(read_json(path / "receipt.json"))
        elif (path / "running.json").exists():
            if self.unit_empty(record):
                self.retire(path, record)
                reason = "permit-expired" if time.time() >= record["expires"] else "supervisor-lost"
                self.finalize(path, record, "stopped" if reason == "permit-expired" else "unknown", reason)
                view.update(read_json(path / "receipt.json"))
            else:
                view["state"] = "running"
        if "exitStatus" not in view and view["state"] in TERMINAL:
            # 旧版回执中的 exitCode 是容器启动门状态，不能证明 payload 的 waitpid 结果。
            # 保留原文件供审计；不重放历史 job，不把历史 128 推断为信号或真实退出码。
            view.update(exitStatus={"kind": "unknown"}, exitCode=None, signal=None)
            if view["state"] == "exited":
                view.update(state="unknown", reason="legacy-exit-status-unconfirmed")
        return view

    def isolate(self, env, reason="environment-fenced"):
        for path, record in self.records(env):
            self.stop(path, record, reason)
        members = json.loads(self.backend.command("ps", "--all", "--filter",
                             "label=kaguya.environment=" + env["environmentId"],
                             "--filter", "label=kaguya.role=shell", "--format=json"))
        # 已登记成员在上面的 stop 中按完整 CID 清理。剩余成员缺少私有归属记录，
        # label/name 不能证明整个 kernel cgroup 已停止，因此整个 fence 必须拒绝 ACK。
        if members:
            raise BrokerError("unknown-shell-member-isolation-unconfirmed")


if __name__ == "__main__":
    request = json.loads(sys.argv[1])
    if request["directory"]:
        fd = open_beneath(request["root"], request["path"], directory=True)
        os.close(fd)
        print("{}")
    else:
        print(canonical(file_result(request["root"], request["path"], request["offset"], request["length"],
                                    request["expected"], request["deadline"])))

