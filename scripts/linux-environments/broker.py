"""功能概述：Linux 工具环境的唯一租约/代次权威，持久保存操作事实而不重试未知副作用。
主要职责：Journal 原子追加 fsync 事件；Broker 管理 acquire/renew/release/takeover、
实际入口 fencing、取消 tombstone、历史核对及内容寻址产物；PodmanBackend 固定容器参数。
人工会话凭证仅存摘要；handoff/resume 等待双向输入排空，关闭或到期后保持人工模式。
可信 Chromium 桌面可显式选择固定 seccomp profile，仅调整内层 sandbox 所需 chroot。
代码库关系：server.py 验 SO_PEERCRED 后调用；TypeScript provider 消费 ActionExecution。
shell_jobs/job_runner 在宿主监督独立命令容器；GUI/browser helper 从不执行任意 shell。
输入输出与副作用：按环境锁串行 admission/启动，外部完成等待不占全局锁；接管先隔离容器。
日志保留旧 generation 和 unknown 事实；重启隔离自动化并保留桌面，绝不恢复派发。
镜像导入先以非阻塞方式打开 inbox，再验证普通文件和内容哈希，避免特殊文件占住连接。
"""
import base64
from datetime import datetime, timezone
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import selectors
import stat
import shutil
import subprocess
import threading
import time
import uuid

CHROMIUM_POLICIES = {
    # runtime 版本与发行包默认 profile 必须同时匹配；未知组合不能回退到旧策略。
    ("4.9.3", "cc374cf23846ce1f62f4dc807a8e2b8673c783c6f56cb475467621035d281e6c"):
        ("chromium-seccomp.json", "8ff973906fd10bbbe904f2b52e567ae9aec30d30af257c71ff4928098b44932f"),
    ("5.7.0", "886ae167646b7e5db381ecf7c31e6de720a8e8da15cf3202fe1f67f424af2b75"):
        ("chromium-seccomp-podman5.json", "4b6639b4c07a385384148acfbb74d950c69137075e10675092a3d689d93ce1c3"),
}


def chromium_profile(version, default_sha256):
    selected = CHROMIUM_POLICIES.get((version, default_sha256))
    if selected is None:
        raise BrokerError("chromium-runtime-policy-unreviewed")
    name, sha256 = selected
    profile = Path(__file__).resolve().with_name(name)
    if profile.is_symlink() or hashlib.sha256(profile.read_bytes()).hexdigest() != sha256:
        raise BrokerError("chromium-seccomp-integrity")
    return profile


class BrokerError(Exception):
    pass


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}", value):
        raise BrokerError("invalid-identifier")
    return value


def text(value):
    if not isinstance(value, str) or not 0 < len(value) <= 4096:
        raise BrokerError("invalid-text")
    return value


def outcome(status="unknown", evidence="unconfirmed", reason="result-unconfirmed"):
    return {"status": status, "evidence": evidence, "result": {"reason": reason},
            "artifacts": [], "truncated": False}


def verify_storage_mount(path, image):
    """确认固定 ext4 loop 挂载的真实 backing file；不能把任意 ismount 当作本安装存储。"""
    path, image = Path(path), Path(image)
    if path.is_symlink() or image.is_symlink():
        raise BrokerError("unsafe-storage-path")
    entries = Path("/proc/self/mountinfo").read_text().splitlines()
    matches = [line.split() for line in entries if len(line.split()) > 6 and line.split()[4] == str(path)]
    if len(matches) != 1:
        raise BrokerError("bounded-storage-not-mounted")
    fields = matches[0]
    split = fields.index("-")
    if fields[split + 1] != "ext4" or not re.fullmatch(r"/dev/loop\d+", fields[split + 2]):
        raise BrokerError("unexpected-storage-filesystem")
    backing = Path("/sys/dev/block") / fields[2] / "loop/backing_file"
    if os.path.realpath(backing.read_text().strip()) != str(image.resolve()):
        raise BrokerError("storage-backing-file-mismatch")
    info = image.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_blocks * 512 < info.st_size:
        raise BrokerError("storage-reservation-invalid")


def atomic(path, data, exclusive=False):
    temp = path.parent / (".pending-" + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if exclusive:
            os.link(temp, path)
            temp.unlink()
        else:
            os.replace(temp, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        temp.unlink(missing_ok=True)


class Journal:
    def __init__(self, root):
        self.root = root
        if root.is_symlink():
            raise BrokerError("symlink-state")
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lockfile = os.open(root / "owner.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(self.lockfile, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.lockfile)
            raise BrokerError("broker-already-running") from None
        self.mutex = threading.RLock()
        self.path = root / "journal"
        self.path.mkdir(mode=0o700, exist_ok=True)
        self.sequence = 0
        self.events = []
        try:
            for path in sorted(self.path.glob("*.json")):
                if path.is_symlink() or path.name != f"{self.sequence + 1:016d}.json":
                    raise BrokerError("journal-sequence-corrupt")
                event = json.loads(path.read_text())
                if event["sequence"] != self.sequence + 1 or event["hash"] != digest(event["value"]):
                    raise BrokerError("journal-corrupt")
                self.events.append(event)
                self.sequence += 1
        except BaseException:
            self.close()
            raise

    def append(self, kind, key, value):
        with self.mutex:
            if self.lockfile is None:
                raise BrokerError("journal-closed")
            sequence = self.sequence + 1
            event = {"sequence": sequence, "kind": kind, "key": key, "value": value, "hash": digest(value)}
            atomic(self.path / f"{sequence:016d}.json", canonical(event).encode(), exclusive=True)
            self.sequence = sequence

    def close(self):
        with self.mutex:
            if self.lockfile is not None:
                os.close(self.lockfile)
                self.lockfile = None


class Broker:
    def __init__(self, root, backend, clock=time.time, max_environments=2,
                 max_artifact_bytes=16 * 1024 ** 2, max_stored_bytes=2 * 1024 ** 3):
        self.root, self.backend, self.clock = Path(root), backend, clock
        self.journal = Journal(self.root)
        if hasattr(backend, "configure"):
            backend.configure(self.root)
        self.guard = threading.RLock()
        self.closed = False
        self.faulted = False
        self.environments, self.operations, self.artifacts, self.locks = {}, {}, {}, {}
        self.max_environments = max_environments
        self.max_artifact_bytes, self.max_stored_bytes = max_artifact_bytes, max_stored_bytes
        self.blobs = self.root / "artifacts"
        self.blobs.mkdir(mode=0o700, exist_ok=True)
        for event in self.journal.events:
            {"environment": self.environments, "operation": self.operations,
             "artifact": self.artifacts}[event["kind"]][event["key"]] = event["value"]
        # 进程重启无法证明旧 helper 的完成位置；先物理隔离，保留日志和历史 receipt。
        failures = []
        for env in list(self.environments.values()):
            try:
                self._quarantine(env)
            except Exception:
                failures.append(env["environmentId"])
        if failures:
            self.closed = True
            self.journal.close()
            raise BrokerError("recovery-isolation-or-journal-failed")

    def _lock(self, env_id):
        with self.guard:
            return self.locks.setdefault(env_id, threading.RLock())

    def _save_env(self, env):
        with self.guard:
            try:
                self.journal.append("environment", env["environmentId"], env)
            except Exception:
                self.faulted = True
                raise
            self.environments[env["environmentId"]] = env

    def _save_op(self, key, op):
        with self.guard:
            try:
                self.journal.append("operation", key, op)
            except Exception:
                self.faulted = True
                raise
            self.operations[key] = op

    def _quarantine(self, env):
        failures = []
        isolated = False
        try:
            self._save_env({**env, "state": "draining"})
        except Exception:
            failures.append("journal")
        # 日志 ENOSPC/EIO 不得跳过实际隔离。
        try:
            result = self.backend.isolate(env)
            if isinstance(result, dict) and "generation" in result:
                actual = result["generation"]
                allowed = {env["generation"], env.get("pendingControl", {}).get("generation", env["generation"])}
                if type(actual) is not int or actual not in allowed:
                    raise BrokerError("isolation-generation-unconfirmed")
                env = {**env, "generation": actual}
                env.pop("pendingControl", None)
            isolated = True
        except Exception:
            failures.append("isolation")
        try:
            self._save_env({**env, "state": "quarantined" if isolated else "isolation_failed", "lease": None, "humanSession": None})
        except Exception:
            failures.append("journal")
        if failures:
            raise BrokerError("isolation-unconfirmed")

    def _env(self, env_id, scope):
        if self.closed or self.faulted:
            raise BrokerError("broker-closed")
        env = self.environments.get(env_id)
        if env is None or env["scope"] != scope:
            raise BrokerError("environment-not-authorized")
        return env

    def public(self, env):
        result = {k: v for k, v in env.items() if k not in ("lease", "container", "releaseReceipt", "humanSession", "pendingHuman", "controlReceipt", "pendingControl", "closedHuman", "pendingHumanClose")}
        session = env.get("humanSession")
        if session:
            result["human"] = {"sessionId": session["id"], "expiresAt": datetime.fromtimestamp(session["expires"], timezone.utc).isoformat().replace("+00:00", "Z")}
        if env.get("pendingControl"):
            result["pendingControl"] = {k: env["pendingControl"][k] for k in ("mode", "generation")}
        return result

    def inspect(self, req):
        with self._lock(req["environmentId"]):
            return self.public(self._env(req["environmentId"], req["scope"]))

    def create(self, req):
        env_id = identifier(req["environmentId"])
        image = req["image"]
        if not isinstance(image, str) or not re.fullmatch(r"[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}", image):
            raise BrokerError("immutable-image-required")
        if req.get("network", "none") not in ("none", "public-web"):
            raise BrokerError("network-policy-not-allowed")
        if req.get("sandboxPolicy", "default") not in ("default", "chromium-v1"):
            raise BrokerError("sandbox-policy-not-allowed")
        if req.get("desktopKind", "tools") not in ("tools", "gui"):
            raise BrokerError("desktop-kind-not-allowed")
        if req.get("desktopKind") == "gui" and req.get("sandboxPolicy") != "chromium-v1":
            raise BrokerError("gui-sandbox-policy-required")
        resources = req["resourceIds"]
        if not isinstance(resources, list) or not 0 < len(resources) <= 16 or len(set(resources)) != len(resources):
            raise BrokerError("invalid-resources")
        resources = sorted(identifier(r) for r in resources)
        with self._lock(env_id):
            with self.guard:
                if self.closed or self.faulted:
                    raise BrokerError("broker-closed")
                if shutil.disk_usage(self.root).free < 64 * 1024 ** 2:
                    raise BrokerError("journal-reserve-required")
                if env_id in self.environments:
                    raise BrokerError("environment-exists")
                if len(self.environments) >= self.max_environments:
                    raise BrokerError("environment-limit")
                workspace = identifier(req["workspaceId"])
                if any(e["workspaceId"] == workspace or set(resources) & set(e["resourceIds"]) for e in self.environments.values()):
                    raise BrokerError("resource-already-owned")
                env = {"environmentId": env_id, "scope": text(req["scope"]), "workspaceId": workspace,
                       "resourceIds": resources, "image": image, "network": req.get("network", "none"),
                       "sandboxPolicy": req.get("sandboxPolicy", "default"),
                       "desktopKind": req.get("desktopKind", "tools"),
                       "generation": 0, "fencing": "0", "lease": None, "state": "preparing",
                       "container": "kaguya-" + digest(env_id)[:20] + "-0"}
                self._save_env(env)
            try:
                if self.closed or self.faulted:
                    raise BrokerError("broker-closed")
                self.backend.create(env)
                self._save_env({**env, "state": "ready"})
            except Exception:
                try:
                    self._quarantine(env)
                except Exception:
                    pass
                raise BrokerError("environment-create-unconfirmed") from None
            return self.public(self.environments[env_id])

    def acquire(self, req):
        env_id = identifier(req["environmentId"])
        with self._lock(env_id):
            env = self._env(env_id, req["scope"])
            if env["state"] != "ready" or env["lease"] is not None:
                raise BrokerError("takeover-required")
            ttl = req.get("ttlSeconds", 60)
            if type(ttl) is not int or not 1 <= ttl <= 300:
                raise BrokerError("invalid-lease-ttl")
            token = secrets.token_urlsafe(48)
            lease = {"workflowId": identifier(req["workflowId"]), "leaseId": uuid.uuid4().hex,
                     "expires": self.clock() + ttl, "tokenHash": digest(token)}
            env = {**env, "lease": lease, "fencing": str(int(env["fencing"]) + 1)}
            self._save_env(env)
            return {"environment": self.reference(env), "token": token}

    def reference(self, env):
        lease = env["lease"]
        return {**{k: env[k] for k in ("environmentId", "generation", "workspaceId", "resourceIds", "fencing")},
                "workflowId": lease["workflowId"], "leaseId": lease["leaseId"],
                "expiresAt": datetime.fromtimestamp(lease["expires"], timezone.utc).isoformat().replace("+00:00", "Z")}

    def _validate(self, ref, token, scope):
        env = self._env(ref["environmentId"], scope)
        lease = env["lease"]
        if env["state"] != "ready" or lease is None or env["generation"] != ref["generation"]:
            raise BrokerError("stale-environment")
        expected = self.reference(env)
        # expiresAt 是原观察快照；当前到期时间只由 broker 的持久租约决定。
        if any(ref.get(k) != expected[k] for k in expected if k != "expiresAt"):
            raise BrokerError("lease-identity-mismatch")
        if lease["expires"] <= self.clock() or not isinstance(token, str) or not hmac.compare_digest(lease["tokenHash"], digest(token)):
            raise BrokerError("lease-not-authorized")
        return env

    def validate(self, req):
        with self._lock(req["environment"]["environmentId"]):
            self._validate(req["environment"], req["token"], req["scope"])
            return {"valid": True}

    def renew(self, req):
        with self._lock(req["environment"]["environmentId"]):
            env = self._validate(req["environment"], req["token"], req["scope"])
            ttl = req.get("ttlSeconds", 60)
            if type(ttl) is not int or not 1 <= ttl <= 300:
                raise BrokerError("invalid-lease-ttl")
            env = {**env, "lease": {**env["lease"], "expires": self.clock() + ttl}}
            self._save_env(env)
            return self.reference(env)

    def release(self, req):
        # 同一身份只允许幂等停止自己的旧代次；过期租约可以收尾，不能取得新执行权。
        with self._lock(req["environment"]["environmentId"]):
            env = self._env(req["environment"]["environmentId"], req["scope"])
            ref = {k: v for k, v in req["environment"].items() if k != "expiresAt"}
            proof = {"reference": ref, "tokenHash": digest(req["token"])}
            previous = env.get("releaseReceipt")
            if previous == proof and env["generation"] == ref["generation"] and env["state"] == "quarantined" and env["lease"] is None:
                return self.public(env)
            if previous == proof and env["generation"] == ref["generation"] and env["state"] in ("draining", "isolation_failed") and env["lease"] is None:
                self._quarantine(env)
                return self.public(self.environments[env["environmentId"]])
            lease = env["lease"]
            if lease is None or env["generation"] != ref["generation"]:
                raise BrokerError("release-identity-mismatch")
            expected = {k: v for k, v in self.reference(env).items() if k != "expiresAt"}
            if ref != expected or not hmac.compare_digest(lease["tokenHash"], proof["tokenHash"]):
                raise BrokerError("release-identity-mismatch")
            self._save_env({**env, "releaseReceipt": proof})
            env = self.environments[env["environmentId"]]
            self._quarantine(env)
            return self.public(self.environments[env["environmentId"]])

    def takeover(self, req):
        env_id = identifier(req["environmentId"])
        text(req["controlAuthorizationId"])
        with self._lock(env_id):
            env = self._env(env_id, req["scope"])
            if env["generation"] != req["generation"]:
                raise BrokerError("stale-environment")
            self._quarantine(env)
            env = self.environments[env_id]
            generation = env["generation"] + 1
            new = {**env, "state": "preparing", "generation": generation, "lease": None,
                   "container": "kaguya-" + digest(env_id)[:20] + "-" + str(generation)}
            preparing = new
            if hasattr(self.backend, "recover_existing"):
                new["container"] = env["container"]
                # 桌面与 journal 两阶段交接：先记录旧代次和目标，ACK 后才提交新代次。
                preparing = {**env, "state": "preparing", "lease": None,
                             "pendingControl": {"mode": "automation", "generation": generation}}
            self._save_env(preparing)
            try:
                if hasattr(self.backend, "recover_existing"):
                    self.backend.recover_existing(env, new)
                else:
                    self.backend.create(new)
                self._save_env({**new, "state": "ready"})
            except Exception:
                try:
                    self._quarantine(preparing)
                except Exception:
                    pass
                raise BrokerError("takeover-create-unconfirmed") from None
            return self.public(self.environments[env_id])

    def handoff(self, req):
        return self._change_control(req, "human")

    def resume(self, req):
        return self._change_control(req, "automation")

    def _change_control(self, req, mode):
        env_id = identifier(req["environmentId"])
        authorization = text(req["controlAuthorizationId"])
        session = None
        session_proof = None
        if mode == "human" and req.get("humanSession") is not None:
            value = req["humanSession"]
            if (not isinstance(value, dict) or set(value) != {"id", "token", "ttlSeconds"} or
                    not isinstance(value["id"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["id"]) or
                    not isinstance(value["token"], str) or not 32 <= len(value["token"]) <= 256 or
                    type(value["ttlSeconds"]) is not int or not 1 <= value["ttlSeconds"] <= 300):
                raise BrokerError("invalid-human-session")
            session_proof = {"id": value["id"], "tokenHash": digest(value["token"]), "ttlSeconds": value["ttlSeconds"]}
            session = {"id": value["id"], "tokenHash": session_proof["tokenHash"], "expires": self.clock() + value["ttlSeconds"]}
        proof = {"authorizationId": authorization, "generation": req["generation"], "mode": mode, "human": session_proof}
        with self._lock(env_id):
            env = self._env(env_id, req["scope"])
            if env.get("controlReceipt") == proof and env["generation"] == req["generation"] + 1:
                return self.public(env)
            if env["generation"] != req["generation"]:
                raise BrokerError("stale-environment")
            pending = env.get("pendingControl")
            desired = {"mode": mode, "generation": env["generation"] + 1, "proof": proof}
            retry = env["state"] == "draining" and pending == desired
            if mode == "automation" and env["state"] != "human" and not retry:
                raise BrokerError("human-handoff-required")
            if mode == "human" and env["state"] not in ("ready", "human") and not retry:
                raise BrokerError("environment-not-ready-for-handoff")
            next_generation = env["generation"] + 1
            if retry:
                session = env.get("pendingHuman")
            self._save_env({**env, "state": "draining", "lease": None, "humanSession": None,
                            "pendingControl": desired, "pendingHuman": session})
            # 此操作保留桌面；backend 必须确认旧自动化通道隔离，不能通过杀桌面冒充。
            transition = {**env, "pendingHuman": session}
            ack = self.backend.handoff(transition, next_generation, mode)
            if (ack.get("helperProtocolVersion") != 1 or ack.get("automationIsolated") is not True or
                    ack.get("humanInputsIsolated") is not True or
                    ack.get("humanSessionId") != (session["id"] if session else None) or
                    ack.get("generation") != next_generation or ack.get("mode") != mode):
                raise BrokerError("handoff-unconfirmed")
            new = {**env, "generation": next_generation, "lease": None,
                   "humanSession": session, "controlReceipt": proof,
                   "state": "human" if mode == "human" else "ready"}
            new.pop("pendingControl", None)
            new.pop("pendingHuman", None)
            self._save_env(new)
            return self.public(new)

    def human_reference(self, env):
        session = env["humanSession"]
        return {**{k: env[k] for k in ("environmentId", "generation", "workspaceId", "resourceIds", "fencing")},
                "workflowId": "human:" + session["id"], "leaseId": session["id"],
                "expiresAt": datetime.fromtimestamp(session["expires"], timezone.utc).isoformat().replace("+00:00", "Z")}

    def _validate_human(self, req, allow_expired=False):
        env = self._env(req["environmentId"], req["scope"])
        session = env.get("humanSession")
        if (env["state"] != "human" or not session or req.get("generation") != env["generation"] or
                req.get("sessionId") != session["id"] or not isinstance(req.get("token"), str) or
                not hmac.compare_digest(digest(req["token"]), session["tokenHash"]) or
                (not allow_expired and session["expires"] <= self.clock())):
            raise BrokerError("human-session-not-authorized")
        return env

    def human_renew(self, req):
        with self._lock(req["environmentId"]):
            env = self._validate_human(req)
            ttl = req.get("ttlSeconds", 60)
            if type(ttl) is not int or not 1 <= ttl <= 300:
                raise BrokerError("invalid-human-session-ttl")
            env = {**env, "humanSession": {**env["humanSession"], "expires": self.clock() + ttl}}
            self._save_env(env)
            return self.public(env)

    def human_close(self, req):
        with self._lock(req["environmentId"]):
            env = self._env(req["environmentId"], req["scope"])
            receipt = env.get("closedHuman")
            proof = {"sessionId": req["sessionId"], "generation": req["generation"], "tokenHash": digest(req["token"])}
            if receipt == proof and env["generation"] == req["generation"] + 1 and env["state"] == "human":
                return self.public(env)
            pending = env.get("pendingHumanClose")
            if not (env["state"] == "draining" and pending == proof):
                self._validate_human(req, allow_expired=True)
            return self._end_human(env, proof)

    def _end_human(self, env, proof):
        generation = env["generation"] + 1
        pending = {"mode": "human", "generation": generation}
        self._save_env({**env, "state": "draining", "lease": None, "humanSession": None,
                        "pendingControl": pending, "pendingHumanClose": proof})
        ack = self.backend.handoff({**env, "pendingHuman": None}, generation, "human")
        if (ack.get("helperProtocolVersion") != 1 or ack.get("humanInputsIsolated") is not True or
                ack.get("automationIsolated") is not True or ack.get("humanSessionId") is not None or
                ack.get("generation") != generation or ack.get("mode") != "human"):
            raise BrokerError("human-input-isolation-unconfirmed")
        new = {**env, "state": "human", "generation": generation, "lease": None, "humanSession": None, "closedHuman": proof}
        for field in ("pendingControl", "pendingHumanClose", "pendingHuman", "controlReceipt"):
            new.pop(field, None)
        self._save_env(new)
        return self.public(new)

    def expire_humans(self):
        with self.guard:
            identities = list(self.environments)
        for env_id in identities:
            with self._lock(env_id):
                env = self.environments[env_id]
                session = env.get("humanSession")
                if env["state"] == "human" and session and session["expires"] <= self.clock():
                    proof = {"sessionId": session["id"], "generation": env["generation"], "tokenHash": session["tokenHash"]}
                elif env["state"] == "draining" and env.get("pendingHumanClose"):
                    proof = env["pendingHumanClose"]
                else:
                    continue
                try:
                    self._end_human(env, proof)
                except Exception:
                    # 状态已保持 draining，下一轮只重试同一幂等隔离，不派发输入。
                    pass

    def _operation(self, req, audience="automation"):
        for field in ("intentId", "attemptId", "operationId", "digest", "toolName"):
            text(req[field])
        text(req["scope"])
        original = req["environment"]
        if not isinstance(req["arguments"], dict) or not isinstance(req["target"], dict):
            raise BrokerError("invalid-operation-input")
        env = self._env(original["environmentId"], req["scope"])
        if original["workspaceId"] != env["workspaceId"] or original["resourceIds"] != env["resourceIds"]:
            raise BrokerError("original-environment-mismatch")
        # 同一 operation 不能通过换 generation/attempt/参数绕过去重。
        body = {k: req[k] for k in ("intentId", "attemptId", "operationId", "digest", "scope",
                                    "toolName", "arguments", "target", "deadline")}
        body["environment"] = {k: v for k, v in original.items() if k != "expiresAt"}
        if audience == "human":
            body["audience"] = "human"
        if req["token"] in canonical(body):
            raise BrokerError("credential-in-operation")
        key = digest([env["environmentId"], req["operationId"]])
        old = self.operations.get(key)
        if old and old["bodyHash"] != digest(body):
            raise BrokerError("operation-conflict")
        return key, old, body

    def execute(self, req):
        return self._execute(req)

    def human_execute(self, req):
        with self._lock(req["environmentId"]):
            env = self._validate_human(req)
            request = {**req, "environment": self.human_reference(env)}
        return self._execute(request, human=True)

    def human_query(self, req):
        with self._lock(req["environmentId"]):
            self._env(req["environmentId"], req["scope"])
            old = self.operations.get(digest([req["environmentId"], text(req["operationId"])]))
            if not old or old["body"].get("audience") != "human" or old["body"]["scope"] != req["scope"]:
                raise BrokerError("human-operation-not-authorized")
            return {"operationId": old["operationId"], "attemptId": old["body"]["attemptId"], "outcome": old.get("outcome", outcome(reason="operation-in-flight"))}

    def _stop_operation_inputs(self, env, human):
        if not human:
            return self._quarantine(env)
        session = env.get("humanSession")
        if session:
            return self._end_human(env, {"sessionId": session["id"], "generation": env["generation"],
                                         "tokenHash": session["tokenHash"]})

    def _execute(self, req, human=False):
        env_id = req["environment"]["environmentId"]
        with self._lock(env_id):
            env = self._validate_human(req) if human else self._validate(req["environment"], req["token"], req["scope"])
            key, old, body = self._operation(req, "human" if human else "automation")
            if old:
                return old.get("outcome", outcome())
            if (req["toolName"] == "shell.exec" and req["arguments"].get("mode") == "verify") or req["toolName"] in ("browser.verify", "gui.verify"):
                original = req["arguments"].get("original")
                if not isinstance(original, dict):
                    raise BrokerError("original-operation-required")
                original_id, attempt = text(original.get("operationId")), text(original.get("attemptId"))
                previous = self.operations.get(digest([env_id, original_id]))
                if previous is None:
                    raise BrokerError("original-operation-not-found")
                source = previous["body"]
                if req["toolName"] == "browser.verify" and source["toolName"] != "browser.act":
                    raise BrokerError("original-operation-mismatch")
                if req["toolName"] == "gui.verify" and source["toolName"] != "gui.act":
                    raise BrokerError("original-operation-mismatch")
                if (source["scope"] != req["scope"] or source["attemptId"] != attempt or
                        source["environment"]["environmentId"] != env_id or
                        source["environment"]["workspaceId"] != env["workspaceId"]):
                    raise BrokerError("original-operation-mismatch")
            if shutil.disk_usage(self.root).free < 64 * 1024 ** 2:
                raise BrokerError("journal-reserve-required")
            if any(o["body"]["environment"]["environmentId"] == env_id and
                   o["body"]["environment"]["generation"] == env["generation"] and
                   o["phase"] in ("prepared", "dispatched") and "outcome" not in o
                   for o in list(self.operations.values())):
                raise BrokerError("environment-operation-in-flight")
            deadline = datetime.fromisoformat(req["deadline"].replace("Z", "+00:00")).timestamp()
            if deadline <= self.clock():
                raise BrokerError("operation-deadline-expired")
            if req["toolName"] not in ("shell.exec", "browser.observe", "browser.act", "browser.verify",
                                       "gui.observe", "gui.act", "gui.verify"):
                raise BrokerError("operation-not-allowed")
            if human and req["toolName"] not in ("gui.observe", "gui.act", "gui.verify"):
                raise BrokerError("human-tool-not-allowed")
            reference = self.human_reference(env) if human else self.reference(env)
            # observe/act/verify 引用必须来自当前 workflow/generation；helper 负责更细的 DOM freshness。
            source = req.get("arguments", {}).get("observation")
            if source is not None and (source.get("generation") != env["generation"] or
                                      source.get("environmentId") != env_id or
                                      source.get("workflowId") != reference["workflowId"]):
                raise BrokerError("stale-observation")
            op = {"operationId": req["operationId"], "body": body, "bodyHash": digest(body), "phase": "prepared"}
            permit_deadline = min(deadline, (env["humanSession"] if human else env["lease"])["expires"])
            permit = {"expiresAt": datetime.fromtimestamp(permit_deadline, timezone.utc).isoformat().replace("+00:00", "Z"),
                      "environmentId": env_id, "generation": env["generation"], "fencing": env["fencing"],
                      "leaseId": reference["leaseId"], "workflowId": reference["workflowId"],
                      "operationId": req["operationId"], "attemptId": req["attemptId"], "digest": req["digest"]}
            if human:
                permit.update(audience="human", humanSessionId=env["humanSession"]["id"])
            op["permit"] = permit
            self._save_op(key, op)
            handle = None
            try:
                # 锁覆盖最后一次 fencing 与实际子进程创建，接管不能越过这个间隙。
                handle = self.backend.launch(env, {**body, "helperProtocolVersion": 1, "kind": "human-operation" if human else "operation", "permit": permit})
                op = {**op, "phase": "dispatched"}
                self._save_op(key, op)
            except Exception:
                result = outcome(reason="dispatch-unconfirmed")
                try:
                    self._stop_operation_inputs(env, human)
                except Exception:
                    pass
                if handle is not None:
                    self.backend.discard(handle)
                self._save_op(key, {**op, "outcome": result})
                return result
        try:
            remaining = permit_deadline - self.clock()
            if remaining <= 0:
                raise BrokerError("dispatch-permit-expired")
            raw = self.backend.collect(handle, min(300, remaining))
            result = self._accept(raw, body, req["token"])
        except Exception:
            result = outcome(reason="effect-unconfirmed")
            with self._lock(env_id):
                current_env = self.environments[env_id]
                if not self.closed and current_env["generation"] == env["generation"]:
                    try:
                        self._stop_operation_inputs(current_env, human)
                    except Exception:
                        pass
        with self._lock(env_id):
            # 接管后的迟到结果仍保存原身份；当前操作资格另由 generation 判定。
            if self.closed:
                return outcome(reason="broker-closed-effect-unconfirmed")
            current = self.operations[key]
            self._save_op(key, {**current, "phase": "returned", "outcome": result})
        return result

    def _control(self, req):
        text(req["controlAuthorizationId"])
        control = req["controlEnvironment"]
        if control["environmentId"] != req["environment"]["environmentId"]:
            raise BrokerError("control-environment-mismatch")
        return self._validate(control, req["token"], req["scope"])

    def cancel(self, req):
        with self._lock(req["environment"]["environmentId"]):
            env = self._control(req)
            key, old, body = self._operation(req)
            if old and old.get("outcome", {}).get("status") == "succeeded":
                return old["outcome"]
            if old is None:
                result = outcome("cancelled", "not-executed", "cancel-tombstone")
                self._save_op(key, {"operationId": req["operationId"], "body": body, "bodyHash": digest(body),
                                    "phase": "cancelled-before-dispatch", "tombstone": True, "outcome": result})
                return result
            self._save_op(key, {**old, "tombstone": True})
            # 旧代次已隔离，当前新容器无需为历史取消再停止。
            if body["environment"]["generation"] == env["generation"]:
                self._quarantine(env)
            result = old.get("outcome", outcome(reason="stopped-effect-unconfirmed"))
            self._save_op(key, {**self.operations[key], "outcome": result})
            return result

    def reconcile(self, req):
        with self._lock(req["environment"]["environmentId"]):
            self._control(req)
            _, old, _ = self._operation(req)
            return old.get("outcome", outcome()) if old else outcome(reason="operation-record-unavailable")

    def _accept(self, raw, body, token):
        if token in canonical(raw):
            raise BrokerError("credential-in-output")
        if raw.get("status") not in ("succeeded", "rejected", "cancelled", "partial", "unknown"):
            raise BrokerError("invalid-helper-status")
        # 返回值只能证明 helper 返回，不能自动升级到外部效果已核实。
        status = raw["status"] if raw["status"] in ("succeeded", "partial", "unknown") else "unknown"
        result = {"status": status, "evidence": "returned" if status == "succeeded" else "unconfirmed",
                  "result": raw.get("result"), "artifacts": [], "truncated": bool(raw.get("truncated", False)),
                  "providerReceiptId": digest([body["environment"]["environmentId"], body["operationId"]])}
        artifacts = raw.get("artifacts", [])
        if not isinstance(artifacts, list):
            raise BrokerError("too-many-artifacts")
        if len(artifacts) > 8:
            result["truncated"] = True
        inline_bytes = 0
        for item in artifacts[:8]:
            data = base64.b64decode(item["dataBase64"], validate=True)
            if token.encode() in data:
                raise BrokerError("artifact-rejected")
            # 单次输出的原始附件总额也受限；helper 在编码前执行相同预算。
            if len(data) > self.max_artifact_bytes or inline_bytes + len(data) > 16 * 1024 ** 2:
                result["truncated"] = True
                continue
            inline_bytes += len(data)
            mime = item["mime"]
            if mime not in ("image/png", "image/jpeg", "image/webp", "text/plain", "text/csv",
                            "application/json", "application/pdf", "application/zip", "application/octet-stream", "video/webm"):
                raise BrokerError("artifact-type-rejected")
            sha = hashlib.sha256(data).hexdigest()
            artifact_id = uuid.uuid4().hex
            metadata = {"id": artifact_id, "hash": sha, "mime": mime, "size": len(data), "scope": body["scope"],
                        "actionId": body["intentId"], "generation": body["environment"]["generation"],
                        "observedAt": datetime.fromtimestamp(self.clock(), timezone.utc).isoformat().replace("+00:00", "Z"),
                        "source": "environment-helper", "retention": "explicit-delete-only"}
            with self.guard:
                if self.closed:
                    raise BrokerError("broker-closed")
                total = sum(p.stat().st_size for p in self.blobs.iterdir() if p.is_file())
                blob = self.blobs / sha
                if total + (0 if blob.exists() else len(data)) > self.max_stored_bytes:
                    result["truncated"] = True
                    continue
                if not blob.exists():
                    atomic(blob, data, exclusive=True)
                elif blob.is_symlink() or hashlib.sha256(blob.read_bytes()).hexdigest() != sha:
                    raise BrokerError("artifact-integrity-failed")
                record = {"metadata": metadata, "attemptId": body["attemptId"], "operationId": body["operationId"],
                          "environmentId": body["environment"]["environmentId"], "digest": body["digest"]}
                self.journal.append("artifact", artifact_id, record)
                self.artifacts[artifact_id] = record
            result["artifacts"].append(metadata)
        return result

    def read_artifact(self, req):
        record = self.artifacts.get(req["id"])
        if (record is None or record["metadata"]["scope"] != req["scope"] or
                (req.get("environmentId") is not None and record["environmentId"] != req["environmentId"])):
            raise BrokerError("artifact-not-authorized")
        artifact = record["metadata"]
        fd = os.open(self.blobs / artifact["hash"], os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as f:
            data = f.read(self.max_artifact_bytes + 1)
        if hashlib.sha256(data).hexdigest() != artifact["hash"]:
            raise BrokerError("artifact-integrity-failed")
        return {"artifact": artifact, "dataBase64": base64.b64encode(data).decode()}

    def close(self):
        with self.guard:
            if self.closed:
                return
            self.closed = True
        # 关闭领取后隔离子进程；journal.close 与 append 共用锁，已进入写入必先完成。
        # 迟到 collect 的 artifact/receipt 写入在 closed 栅栏拒绝，不等待永久挂起的 provider。
        failures = []
        for env_id in list(self.environments):
            with self._lock(env_id):
                env = self.environments[env_id]
                try:
                    self._quarantine(env)
                except Exception:
                    failures.append(env_id)
        self.journal.close()
        if failures:
            raise BrokerError("close-isolation-unconfirmed")


class PodmanBackend:
    def __init__(self):
        self.shell = None
        self.env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/var/lib/kaguya-tools",
                    "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
                    "CONTAINERS_STORAGE_CONF": "/etc/kaguya-tools/storage.conf"}

    def configure(self, root):
        from shell_jobs import ShellJobs
        self.shell = ShellJobs(root, self)

    def import_image(self, sha):
        if not isinstance(sha, str) or not re.fullmatch(r"[a-f0-9]{64}", sha):
            raise BrokerError("invalid-image-checksum")
        storage = Path("/var/lib/kaguya-tools-storage/containers")
        verify_storage_mount(storage, storage.with_suffix(".img"))
        private = storage / "imports"
        private.mkdir(mode=0o700, exist_ok=True)
        destination = private / uuid.uuid4().hex
        source = os.open(storage / "inbox" / (sha + ".oci"), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        size = os.fstat(source).st_size
        if not stat.S_ISREG(os.fstat(source).st_mode) or not 0 < size <= 12 * 1024 ** 3:
            os.close(source)
            raise BrokerError("invalid-image-archive")
        try:
            hasher = hashlib.sha256()
            total = 0
            with os.fdopen(source, "rb") as src, destination.open("xb") as dst:
                while chunk := src.read(1024 ** 2):
                    total += len(chunk)
                    if total > size:
                        raise BrokerError("image-changed-during-import")
                    hasher.update(chunk)
                    dst.write(chunk)
                dst.flush()
                os.fsync(dst.fileno())
            if total != size or hasher.hexdigest() != sha:
                raise BrokerError("image-checksum-mismatch")
            self.command("load", "--input", str(destination), timeout=300)
            return {"imported": True, "archiveSha256": sha}
        finally:
            destination.unlink(missing_ok=True)

    def command(self, *args, timeout=30):
        try:
            return subprocess.run(["/usr/bin/podman", *args], env=self.env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=True).stdout
        except (OSError, subprocess.SubprocessError):
            raise BrokerError("podman-command-failed") from None

    def create(self, env):
        # 仅使用命名卷；不接受任何客户端宿主路径或 Podman 参数。
        volume = "kaguya-workspace-" + digest(env["workspaceId"])[:24]
        network = "none" if env["network"] == "none" else "pasta:--no-map-gw"
        member_args = []
        gui = env.get("desktopKind") == "gui"
        if gui and self.shell is None:
            raise BrokerError("gui-managed-resource-slice-required")
        if env.get("sandboxPolicy") == "chromium-v1":
            profile = self.chromium_profile()
            member_args += ["--security-opt=seccomp=" + str(profile)]
            if not gui:
                member_args += ["--env=KAGUYA_BROWSER_ENABLED=1"]
        if self.shell is not None:
            if gui:
                self.prepare_gui_home(env)
            member_args += ["--cgroup-parent=" + self.shell.configure_environment(env),
                           "--label=kaguya.role=desktop", "--volume",
                           "kaguya-private-" + digest(env["environmentId"])[:24] + ":/private:rw"]
        if gui:
            member_args += ["--tmpfs=/run/kaguya-app:rw,nosuid,nodev,size=32m,mode=1777",
                            "--tmpfs=/home/app:rw,nosuid,nodev,size=256m,mode=1777"]
        entry = ["--entrypoint=/usr/local/bin/node", env["image"], "/opt/kaguya-tools/gui-init.mjs"] if gui else ["--entrypoint=/opt/kaguya-tools/init", env["image"]]
        self.command("run", "--detach", "--pull=never", "--name", env["container"],
                     *member_args,
                     "--label", "kaguya.environment=" + env["environmentId"],
                     "--userns=keep-id:uid=1000,gid=1000", "--user=1000:1000", "--cap-drop=ALL",
                     "--security-opt=no-new-privileges", "--read-only", "--network=" + network,
                     "--ipc=private", "--pid=private", "--cgroupns=private", "--cpus=1", "--memory=2g",
                     "--memory-swap=2g", "--pids-limit=" + ("384" if gui else "256"), "--shm-size=512m", "--init",
                     "--tmpfs=/tmp:rw,nosuid,nodev,size=512m", "--tmpfs=/run:rw,nosuid,nodev,size=64m",
                     "--tmpfs=/home/tool:rw,nosuid,nodev,size=256m,mode=0700,U",
                     "--volume", volume + ":/workspace:rw", "--env=HOME=/home/tool",
                     "--env=KAGUYA_HELPER_PROTOCOL_VERSION=1", "--env=KAGUYA_ENVIRONMENT_ID=" + env["environmentId"],
                     "--env=KAGUYA_ENVIRONMENT_GENERATION=" + str(env["generation"]),
                     "--env=CUA_DRIVER_RS_TELEMETRY_ENABLED=false", "--env=DO_NOT_TRACK=1", "--env=CUA_TELEMETRY=0",
                     *entry, timeout=60)
        info = json.loads(self.command("inspect", env["container"]))[0]
        if not info["State"]["Running"]:
            raise BrokerError("environment-not-running")
        if gui:
            self.command("exec", "--detach", "--user=1001:1001", env["container"],
                         "/usr/bin/python3", "/opt/kaguya-tools/gui-app-session.py")
            self.command("exec", "--user=1001:1001", env["container"], "/usr/bin/python3", "-I", "-c",
                         "import pathlib,time; p=pathlib.Path('/run/kaguya-app/session/ready'); "
                         "deadline=time.monotonic()+15\n"
                         "while not p.is_file():\n"
                         " if time.monotonic()>=deadline: raise RuntimeError('gui-session-not-ready')\n"
                         " time.sleep(.02)\n", timeout=20)
        # init 必须先就绪固定内部服务，再让 helper 的 health 返回；running 不是能力就绪证明。
        ready = self.collect(self.launch(env, {"helperProtocolVersion": 1, "kind": "health"}), 15)
        if (ready.get("helperProtocolVersion") != 1 or ready.get("ready") is not True or
                ready.get("generation") != env["generation"]):
            raise BrokerError("helper-not-ready")
        if gui and not {"gui.observe", "gui.act", "gui.verify"}.issubset(ready.get("capabilities", [])):
            raise BrokerError("gui-helper-capabilities-required")

    def prepare_gui_home(self, env):
        """在 rootless 用户 namespace 初始化固定命名卷；不提升容器 capability，也不递归 chown 用户内容。"""
        volume = "kaguya-private-" + digest(env["environmentId"])[:24]
        self.command("volume", "create", "--ignore", volume)
        info = json.loads(self.command("volume", "inspect", volume))[0]
        if info.get("Name") != volume or not isinstance(info.get("Mountpoint"), str):
            raise BrokerError("gui-private-volume-unconfirmed")
        self.command("unshare", "/usr/bin/python3", "-I", "-c",
                     "import os,pathlib,stat,sys; p=pathlib.Path(sys.argv[1]); "
                     "assert p.is_absolute() and p.resolve()==p; "
                     "root=os.open(p,os.O_DIRECTORY|os.O_NOFOLLOW); "
                     "assert os.fstat(root).st_uid in (0,1000); "
                     "os.fchown(root,1000,1000); os.fchmod(root,0o711)\n"
                     "try: os.mkdir('app',0o700,dir_fd=root)\n"
                     "except FileExistsError: pass\n"
                     "app=os.open('app',os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root); "
                     "assert os.fstat(app).st_uid in (0,1001); "
                     "os.fchown(app,1001,1001); os.fchmod(app,0o700); os.close(app); os.close(root)",
                     info["Mountpoint"])

    def chromium_profile(self):
        info = json.loads(self.command("info", "--format=json"))
        security = info["host"]["security"]
        default = Path(security["seccompProfilePath"])
        if not security["rootless"] or not security["seccompEnabled"] or default.is_symlink():
            raise BrokerError("chromium-runtime-policy-unreviewed")
        return chromium_profile(info["version"]["Version"], hashlib.sha256(default.read_bytes()).hexdigest())

    def handoff(self, env, generation, mode):
        if self.shell is not None:
            self.shell.isolate(env, "handoff")
        request = {"helperProtocolVersion": 1, "kind": "control", "action": "handoff",
                   "environmentId": env["environmentId"], "expectedGeneration": env["generation"],
                   "generation": generation, "mode": mode,
                   "controlOperationId": digest([env["environmentId"], env["generation"], generation, mode])}
        session = env.get("pendingHuman") if mode == "human" else None
        if session:
            request["humanSessionId"] = session["id"]
            request["controlOperationId"] = digest([env["environmentId"], env["generation"], generation, mode, session["id"]])
        return self.collect(self.launch(env, request), 15)

    def isolate(self, env):
        if self.shell is not None:
            self.shell.isolate(env)
            exists = self.command("ps", "--filter", "name=^" + env["container"] + "$", "--format={{.ID}}")
            if exists.strip():
                actual = env["generation"]
                if env.get("pendingControl"):
                    health = self.collect(self.launch(env, {"helperProtocolVersion": 1, "kind": "health"}), 15)
                    actual = health.get("generation")
                    if (health.get("helperProtocolVersion") != 1 or health.get("ready") is not True or
                            type(actual) is not int or actual not in (env["generation"], env["pendingControl"]["generation"])):
                        raise BrokerError("control-transition-unconfirmed")
                request = {"helperProtocolVersion": 1, "kind": "control", "action": "fence",
                           "environmentId": env["environmentId"], "expectedGeneration": actual,
                           "controlOperationId": digest([env["environmentId"], actual, "fence"])}
                ack = self.collect(self.launch(env, request), 15)
                if (ack.get("helperProtocolVersion") != 1 or ack.get("automationIsolated") is not True or
                        ack.get("generation") != actual):
                    raise BrokerError("automation-isolation-unconfirmed")
                return {"generation": actual}
            return
        self.stop_container(env["container"])

    def recover_existing(self, old, new):
        if self.command("ps", "--filter", "name=^" + old["container"] + "$", "--format={{.ID}}").strip():
            ack = self.handoff(old, new["generation"], "automation")
            if ack.get("automationIsolated") is not True or ack.get("generation") != new["generation"]:
                raise BrokerError("recovery-control-unconfirmed")
        else:
            self.command("rm", "--force", "--ignore", old["container"])
            self.create(new)

    def stop_container(self, name):
        exists = subprocess.run(["/usr/bin/podman", "container", "exists", name], env=self.env,
                                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        if exists.returncode == 1:
            return
        if exists.returncode != 0:
            raise BrokerError("isolation-unconfirmed")
        # systemd 可能同时杀死 conmon 和 payload；先向 OCI runtime 同步，不能将
        # 缺少 conmon exit-file 的缓存 Running/Pid 当作真实进程状态，也不能直接忽略它。
        self.command("ps", "--all", "--sync", "--filter", "name=^" + name + "$", "--format={{.ID}}")
        current = json.loads(self.command("inspect", name))[0]["State"]
        if current["Running"]:
            try:
                self.command("kill", "--signal=KILL", name, timeout=15)
                self.command("wait", name, timeout=15)
            except BrokerError:
                pass  # 并发自然退出后仍以下面的真实状态为准。
        self.command("ps", "--all", "--sync", "--filter", "name=^" + name + "$", "--format={{.ID}}")
        state = json.loads(self.command("inspect", name))[0]["State"]
        if state["Running"] or state.get("Pid", 0) != 0:
            raise BrokerError("isolation-unconfirmed")

    def launch(self, env, body):
        if body.get("toolName") == "shell.exec":
            if self.shell is None:
                raise BrokerError("shell-control-not-configured")
            return self.shell.handle(env, body)
        proc = subprocess.Popen(["/usr/bin/podman", "exec", "-i", env["container"], "/opt/kaguya-tools/helper"],
                                env=self.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return proc, canonical(body).encode() + b"\n"

    def discard(self, handle):
        if isinstance(handle, dict):
            return
        proc, _ = handle
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            stream.close()

    def collect(self, handle, timeout):
        if isinstance(handle, dict):
            return handle
        proc, request = handle
        selector = selectors.DefaultSelector()
        output = bytearray()
        offset, error_size = 0, 0
        deadline = time.monotonic() + timeout
        try:
            for stream, event in ((proc.stdin, selectors.EVENT_WRITE), (proc.stdout, selectors.EVENT_READ),
                                  (proc.stderr, selectors.EVENT_READ)):
                os.set_blocking(stream.fileno(), False)
                selector.register(stream, event)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise BrokerError("helper-timeout")
                for key, _ in selector.select(remaining):
                    stream = key.fileobj
                    if stream is proc.stdin:
                        offset += os.write(stream.fileno(), request[offset:offset + 4096])
                        if offset == len(request):
                            selector.unregister(stream)
                            stream.close()
                    else:
                        data = os.read(stream.fileno(), 65536)
                        if not data:
                            selector.unregister(stream)
                            stream.close()
                        elif stream is proc.stdout:
                            output.extend(data)
                            if len(output) > 24 * 1024 ** 2:
                                raise BrokerError("helper-output-limit")
                        else:
                            error_size += len(data)
                            if error_size > 1024 ** 2:
                                raise BrokerError("helper-error-limit")
            if proc.wait(timeout=max(0.1, deadline - time.monotonic())) != 0:
                raise BrokerError("helper-failed")
            return json.loads(output)
        finally:
            selector.close()
            self.discard(handle)
