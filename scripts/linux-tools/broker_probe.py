#!/usr/bin/env python3
"""功能概述：真实 Linux CI 的 broker 崩溃夹具，在 dispatched 持久屏障后等待被 SIGKILL。
主要职责：使用生产 Broker/PodmanBackend 创建环境与 shell job；启动窗口模式暂停真实 gate；collect 暂扣回执，stdout
只发无 token 的测试身份。恢复方据原 operation 核对 unknown，不重新派发。
代码库关系：supervisor_checks.py 启动并回收本进程及所有实际容器，不能用于生产部署。
输入输出与副作用：仅随机 CI 环境；测试 argv 写一次效果和延迟 marker，无网络或 LLM。
"""
from datetime import datetime, timedelta, timezone
import json
import os
import signal
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "linux-environments"))
from broker import Broker, PodmanBackend  # noqa: E402

# 启动窗口夹具：保留生产 run，只在真实 gate ready 后、inspect/放行前暂停宿主 supervisor。
if sys.argv[1] == "--startup-window":
    import job_runner
    gate = job_runner.read_gate
    def paused_gate(proc, deadline):
        gate(proc, deadline)
        os.kill(os.getpid(), signal.SIGSTOP)
    job_runner.read_gate = paused_gate
    job_runner.run(Path(sys.argv[2]))
    raise SystemExit(0)

root, image, key = sys.argv[1:]
backend = PodmanBackend()
backend.env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS")}
backend.env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
broker = Broker(root, backend)
environment = broker.create({"environmentId": key, "scope": "ci", "workspaceId": key,
                             "resourceIds": [key + "-desktop"], "image": image, "network": "none"})
binding = broker.acquire({"environmentId": key, "scope": "ci", "workflowId": "flow", "ttlSeconds": 20})
request = {"environment": binding["environment"], "token": binding["token"], "scope": "ci",
           "intentId": "intent", "operationId": "crash-operation", "attemptId": "crash-attempt", "digest": "1" * 64,
           "toolName": "shell.exec", "target": {}, "deadline": (datetime.now(timezone.utc) + timedelta(seconds=20)).isoformat(),
           "arguments": {"mode": "start", "argv": ["/usr/bin/python3", "-c",
                        "import time; open('once','a').write('1'); time.sleep(30); open('late','w').write('bad')"], "cwd": ".", "env": {}}}
collect = backend.collect

def withheld(handle, timeout):
    if isinstance(handle, dict) and handle.get("result", {}).get("accepted"):
        print(json.dumps({"environment": environment, "job": handle["result"],
                          "request": {k: v for k, v in request.items() if k != "token"}}), flush=True)
        sys.stdin.read()
        raise RuntimeError("crash-probe-released-without-kill")
    return collect(handle, timeout)

backend.collect = withheld
broker.execute(request)
