"""功能概述：真实 Linux CI 的攻击、固定截止与崩溃恢复验证。
主要职责：check_gate 使用真实 OpenSSL provider 构造函数验证启动门环境；check_deadlines
暂停 supervisor 并确认独立 timer 清空后代；check_broker_crash 在持久 dispatched 后杀 broker。
代码库关系：check-container.py 调用；复用生产命令构建/文件访问和 Broker，而非替身 runtime。
输入输出与副作用：临时 C/共享库和随机环境；每个实际进程立即登记 finally 清理，所有等待有界。
"""
import base64
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import time
import uuid

from broker import Broker, BrokerError, PodmanBackend, digest
from job_runner import container_command, payload_empty, read_gate
from shell_jobs import read_json


def cleanup_all(actions):
    primary = sys.exc_info()[1]
    errors = []
    for action in actions:
        try:
            action()
        except Exception as error:
            errors.append(error)
    if errors:
        raise BaseExceptionGroup("supervisor probe cleanup failed", ([primary] if primary else []) + errors)


def stop_process(proc):
    if proc.poll() is None:
        proc.kill()
    proc.wait(timeout=5)


def wait_until(read, predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while True:
        value = read()
        if predicate(value):
            return value
        if time.monotonic() >= deadline:
            raise AssertionError({"supervisorWaitTimeout": value})
        time.sleep(0.02)


def exists(backend, env, path):
    value = backend.command("exec", env["container"], "/usr/bin/python3", "-c",
                            "import os,sys;print(int(os.path.exists('/workspace/'+sys.argv[1])))", path)
    return value.strip() == b"1"


def terminal(operation, job_id):
    return wait_until(lambda: operation("query", jobId=job_id)["result"], lambda r: r["state"] in ("exited", "stopped", "unknown"))


def request(environment, mode="start", ttl=30, **args):
    op = uuid.uuid4().hex
    expiry = (datetime.now(timezone.utc) + timedelta(seconds=ttl)).isoformat()
    ref = {"environmentId": environment["environmentId"], "generation": environment["generation"], "fencing": "1", "leaseId": "lease", "workflowId": "flow"}
    return {"environment": ref, "scope": "ci", "operationId": op, "attemptId": op, "digest": op,
            "deadline": expiry, "toolName": "shell.exec", "arguments": {"mode": mode, **args},
            "permit": {**ref, "operationId": op, "attemptId": op, "digest": op, "expiresAt": expiry}}


def check_gate(backend, env, operation, root):
    source = Path(root) / "provider.c"
    binary = Path(root) / "provider.so"
    source.write_text('''#include <stdio.h>
typedef struct {int function_id; void (*function)(void);} Dispatch;
__attribute__((constructor)) static void loaded(void) {FILE *f=fopen("/workspace/provider-loaded","w");if(f){fputs("loaded",f);fclose(f);}}
static const Dispatch dispatch[]={{0,0}};
int OSSL_provider_init(void *h,const Dispatch *in,const Dispatch **out,void **ctx){*out=dispatch;*ctx=0;return 1;}
''')
    subprocess.run(["/usr/bin/cc", "-shared", "-fPIC", str(source), "-o", str(binary)], check=True, timeout=30)
    config = "nodejs_conf = init\n[init]\nproviders = providers\n[providers]\ndefault = defaults\nprobe = probe\n[defaults]\nactivate = 1\n[probe]\nmodule = /workspace/provider.so\nactivate = 1\n"
    code = "import base64;open('provider.so','wb').write(base64.b64decode(" + repr(base64.b64encode(binary.read_bytes()).decode()) + "));open('provider.cnf','w').write(" + repr(config) + ")"
    setup = operation("start", argv=["/usr/bin/python3", "-c", code], cwd=".", env={})["result"]
    assert terminal(operation, setup["jobId"])["exitCode"] == 0
    req = request(env, argv=["/usr/local/bin/node", "-e", "require('fs').writeFileSync('gate-env',process.env.GATE_VALUE)"], cwd=".",
                  env={"OPENSSL_CONF": "/workspace/provider.cnf", "GATE_VALUE": "after-release"})
    path, record, _ = backend.shell.prepare(env, req, backend.shell.check(env, req))
    # 此独立 gate 测试用同一生产命令生成器；仅将 cgroup 放入已经受限的 jobs slice。
    # 完整 supervisor 对 split 归属的实测由下面的 deadline 测试承担。
    command = [v for v in container_command(record) if v not in ("--cgroup-manager=cgroupfs", "--cgroups=split")]
    command.insert(2, "--cgroup-parent=" + backend.shell.job_slice(env))
    proc = subprocess.Popen(command, env=backend.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        read_gate(proc, time.monotonic() + 15)
        assert not exists(backend, env, "provider-loaded"), "provider executed before run release"
        assert not exists(backend, env, "gate-env"), "argv executed before run release"
        proc.stdin.write(b"run\n")
        proc.stdin.close()
        proc.stdin = None
        output, errors = proc.communicate(timeout=10)
        assert proc.returncode == 0, errors.decode()
        assert exists(backend, env, "provider-loaded"), "provider fixture did not exercise OpenSSL startup"
        result = backend.shell.workspace_read(env, "gate-env", time.time() + 10, length=100)
        assert base64.b64decode(result["dataBase64"]) == b"after-release"
        print(json.dumps({"gateProvider": {"withheldRunEffects": 0, "releasedProviderLoaded": True, "jobEnvironmentCorrect": True}}), flush=True)
    finally:
        cleanup_all([lambda: backend.stop_container(record["container"]),
                     lambda: backend.command("rm", "--force", "--ignore", record["container"]), lambda: stop_process(proc),
                     *[stream.close for stream in (proc.stdin, proc.stdout, proc.stderr) if stream]])


def check_startup_window(backend, env):
    req = request(env, ttl=12, argv=["/bin/sh", "-c", "echo bad > early-release"], cwd=".", env={})
    path, record, _ = backend.shell.prepare(env, req, backend.shell.check(env, req))
    command = backend.shell.unit_command(path, record)
    command[-2:] = [str(Path(__file__).with_name("broker_probe.py")), "--startup-window", str(path)]
    backend.shell.system(*command)
    def paused():
        pid = int(backend.shell.properties(record["unit"]).get("MainPID", "0"))
        try:
            return pid and "\nState:\tT" in Path(f"/proc/{pid}/status").read_text()
        except FileNotFoundError:
            return False
    wait_until(paused, bool)
    assert (path / "armed.json").exists() and (path / "container.cid").exists()
    assert not (path / "running.json").exists() and not exists(backend, env, "early-release")
    cid = (path / "container.cid").read_text().strip()
    armed = read_json(path / "armed.json")
    # 不发 stop/kill；原独立 timer 必须终止尚未发布 running.json 的整个 unit。
    wait_until(lambda: payload_empty(armed["unitGroup"]), bool, max(1, record["expires"] - time.time()) + 5)
    backend.shell.retire(path, record)
    assert backend.shell.stopped(record)
    assert read_json(path / "retired.json")["containerId"] == cid
    assert not exists(backend, env, "early-release")
    print(json.dumps({"startupWindow": {"runningRecordAbsent": True, "effects": 0,
                                        "fullCidRetired": cid, "unitCgroupEmpty": True, "independentDeadline": record["permitExpiresAt"]}}), flush=True)


def check_deadlines(backend, env, operation):
    name = "daemon-" + uuid.uuid4().hex
    code = """import os,signal,time
signal.signal(signal.SIGTERM,signal.SIG_IGN)
if os.fork()==0:
 os.setsid()
 if os.fork()>0: os._exit(0)
 open(%r,'w').write('ready')
 time.sleep(30)
 open(%r,'w').write('escaped')
while True: time.sleep(1)
""" % (name + "-ready", name + "-late")
    start = operation("start", ttl=12, argv=["/usr/bin/python3", "-c", code], cwd=".", env={})["result"]
    path = backend.shell.root / start["jobId"]
    record, running = read_json(path / "manifest.json"), read_json(path / "running.json")
    wait_until(lambda: exists(backend, env, name + "-ready"), bool)
    os.kill(running["supervisorPid"], signal.SIGSTOP)
    wait_until(lambda: Path(f"/proc/{running['supervisorPid']}/status").read_text(), lambda value: "\nState:\tT" in value)
    wait_until(lambda: payload_empty(running["unitGroup"]), bool, max(1, record["expires"] - time.time()) + 5)
    # 先观察 kernel 的空 cgroup，再同步 runtime；这里未发 stop/kill 来促成测试结果。
    backend.shell.retire(path, record)
    assert backend.shell.stopped(record)
    assert not exists(backend, env, name + "-late")
    result = operation("query", jobId=start["jobId"])["result"]
    assert result["state"] == "stopped" and result["reason"] == "permit-expired", result
    print(json.dumps({"supervisorStoppedDeadline": {"manifestDeadline": record["permitExpiresAt"], "groups": running, "result": result}}), flush=True)
    # 真实 transient unit 在 ExecStartPre 中排队，旧许可到期后 supervisor 才启动。
    # 延时仅用于制造业务截止场景；等待结果仍观察 unit 终态，不固定休眠猜测完成。
    req = request(env, ttl=2, argv=["/bin/sh", "-c", "echo bad > expired-before-start"], cwd=".", env={})
    path, record, _ = backend.shell.prepare(env, req, backend.shell.check(env, req))
    delayed = backend.shell.unit_command(path, record)
    delayed.insert(2, "--property=ExecStartPre=/usr/bin/sleep 3")
    backend.shell.system(*delayed, check=False)
    wait_until(lambda: backend.shell.properties(record["unit"]), lambda p: p.get("ActiveState") in ("inactive", "failed"), 8)
    assert not (path / "claimed").exists() and not exists(backend, env, "expired-before-start")
    journal = subprocess.check_output(["/usr/bin/journalctl", "--user", "-u", record["unit"], "--no-pager"], env=backend.env)
    assert b"job-expired-before-launch" in journal
    print(json.dumps({"expiredBeforeLaunchEffects": 0, "queuedUnitDeadline": record["permitExpiresAt"]}), flush=True)


def check_broker_crash(parent_backend, image, root):
    key = "ci-crash-" + uuid.uuid4().hex
    state = Path(root) / "crash-broker"
    backend = PodmanBackend()
    backend.env = dict(parent_backend.env)
    backend.configure(state)
    child = subprocess.Popen(["/usr/bin/python3", "-B", str(Path(__file__).with_name("broker_probe.py")), str(state), image, key],
                             env=backend.env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    broker = None
    env = {"environmentId": key, "workspaceId": key, "container": "kaguya-" + digest(key)[:20] + "-0"}
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(child.stdout, selectors.EVENT_READ)
            assert selector.select(25), "broker did not reach durable dispatch"
            line = child.stdout.readline()
            assert line, child.stderr.read().decode()
        message = json.loads(line)
        env = {**env, **message["environment"]}
        job_id = message["job"]["jobId"]
        path = backend.shell.root / job_id
        record, running = read_json(path / "manifest.json"), read_json(path / "running.json")
        desktop_pid = json.loads(backend.command("inspect", env["container"]))[0]["State"]["Pid"]
        wait_until(lambda: exists(backend, env, "once"), bool)
        child.kill()
        child.wait(timeout=5)
        wait_until(lambda: payload_empty(running["payloadGroup"]), bool, max(1, record["expires"] - time.time()) + 5)
        wait_until(lambda: payload_empty(running["unitGroup"]), bool, 5)
        backend.shell.retire(path, record)
        assert backend.shell.stopped(record)
        assert not exists(backend, env, "late")
        immutable = {p.name: p.read_bytes() for p in (state / "journal").glob("*.json")}
        broker = Broker(state, backend)
        recovered = broker.takeover({"environmentId": key, "scope": "ci", "generation": 0, "controlAuthorizationId": "recovery"})
        binding = broker.acquire({"environmentId": key, "scope": "ci", "workflowId": "new", "ttlSeconds": 60})
        control = {**message["request"], "controlEnvironment": binding["environment"], "token": binding["token"], "controlAuthorizationId": "verify-original"}
        assert broker.reconcile(control)["status"] == "unknown"
        assert json.loads(backend.command("inspect", env["container"]))[0]["State"]["Pid"] == desktop_pid
        assert base64.b64decode(backend.shell.workspace_read(env, "once", time.time() + 10, length=100)["dataBase64"]) == b"1"
        for name, data in immutable.items():
            assert (state / "journal" / name).read_bytes() == data
        before_replay = {p.name: p.read_bytes() for p in (state / "journal").glob("*.json")}
        try:
            broker.execute({**message["request"], "environment": binding["environment"], "token": binding["token"]})
            raise AssertionError("old operation reexecuted")
        except BrokerError as error:
            assert str(error) == "operation-conflict", str(error)
        assert {p.name: p.read_bytes() for p in (state / "journal").glob("*.json")} == before_replay
        assert base64.b64decode(backend.shell.workspace_read(env, "once", time.time() + 10, length=100)["dataBase64"]) == b"1"
        print(json.dumps({"brokerCrash": {"groups": running, "deadline": record["permitExpiresAt"], "recoveredGeneration": recovered["generation"],
                                           "originalOutcome": "unknown", "effectCount": 1, "desktopPidPreserved": True}}), flush=True)
        class TransitionCrash(BaseException):
            pass
        windows = []
        for after in (False, True):
            before = broker.environments[key]["generation"]
            recover = backend.recover_existing
            def interrupted(old, new):
                if after:
                    recover(old, new)
                raise TransitionCrash()
            backend.recover_existing = interrupted
            try:
                try:
                    broker.takeover({"environmentId": key, "scope": "ci", "generation": before, "controlAuthorizationId": "transition"})
                    raise AssertionError("transition fault not reached")
                except TransitionCrash:
                    pass
                assert broker.environments[key]["generation"] == before
                assert broker.environments[key]["pendingControl"]["generation"] == before + 1
            finally:
                backend.recover_existing = recover
                broker.journal.close()
                broker.closed = True
            broker = Broker(state, backend)
            recovered = broker.environments[key]
            assert recovered["generation"] == before + int(after) and recovered["state"] == "quarantined"
            assert recovered["lease"] is None and "pendingControl" not in recovered
            assert json.loads(backend.command("inspect", env["container"]))[0]["State"]["Pid"] == desktop_pid
            ready = broker.takeover({"environmentId": key, "scope": "ci", "generation": recovered["generation"], "controlAuthorizationId": "explicit-recovery"})
            windows.append({"afterHelper": after, "recoveredGeneration": recovered["generation"], "readyGeneration": ready["generation"]})
        generation = broker.environments[key]["generation"]
        handoff = backend.handoff
        def lost_ack(*args):
            handoff(*args)
            raise BrokerError("ci-lost-control-ack")
        backend.handoff = lost_ack
        try:
            try:
                broker.handoff({"environmentId": key, "scope": "ci", "generation": generation, "controlAuthorizationId": "lost-ack"})
                raise AssertionError("control ACK was not withheld")
            except BrokerError as error:
                assert str(error) == "ci-lost-control-ack", str(error)
        finally:
            backend.handoff = handoff
        taken = broker.takeover({"environmentId": key, "scope": "ci", "generation": generation, "controlAuthorizationId": "takeover-pending"})
        assert taken["generation"] == generation + 2
        assert json.loads(backend.command("inspect", env["container"]))[0]["State"]["Pid"] == desktop_pid
        print(json.dumps({"controlTransitionRecovery": {"windows": windows, "sameProcessLostAckGeneration": taken["generation"],
                                                        "desktopPidPreserved": True}}), flush=True)
    finally:
        actions = [lambda: stop_process(child), *[stream.close for stream in (child.stdin, child.stdout, child.stderr)]]
        if broker:
            actions.append(broker.close)
        for path, record in backend.shell.records(env):
            actions.append(lambda p=path, r=record: backend.shell.stop(p, r, "ci-cleanup"))
            actions.append(lambda r=record: backend.command("rm", "--force", "--ignore", r["container"]))
        actions.extend([lambda: backend.stop_container(env["container"]),
                        lambda: backend.command("rm", "--force", "--ignore", env["container"])])
        for prefix in ("kaguya-workspace-", "kaguya-private-"):
            actions.append(lambda p=prefix: backend.command("volume", "rm", "--force", p + digest(key)[:24]))
        actions.append(lambda: backend.shell.system("/usr/bin/systemctl", "--user", "stop", backend.shell.slice(env)))
        cleanup_all(actions)
