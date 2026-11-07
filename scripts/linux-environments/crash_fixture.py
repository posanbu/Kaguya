"""功能概述：仅供测试的真实进程崩溃夹具，用落盘计数表示受控外部效果。
主要职责：EffectBackend 在 launch 写入并 fsync 效果；collect 输出屏障后阻塞 stdin，供父测试 SIGKILL。
代码库关系：test_crash.py 重开生产 Broker，检查 dispatched 未回执不会重发；不运行 Podman。
输入输出与副作用：仅写测试传入的独立临时目录，stdout 中身份使用虚构测试数据。
"""
import json
import os
from pathlib import Path
import sys
from broker import Broker


class EffectBackend:
    def __init__(self, root):
        self.root = root
        self.request = None

    def create(self, env):
        pass

    def isolate(self, env):
        pass

    def launch(self, env, request):
        with (self.root / "effect-count").open("w") as f:
            f.write("1")
            f.flush()
            os.fsync(f.fileno())
        return None

    def collect(self, handle, timeout):
        print(json.dumps(self.request), flush=True)
        sys.stdin.buffer.read(1)
        raise RuntimeError("parent-should-kill")


if __name__ == "__main__":
    root = Path(sys.argv[1])
    backend = EffectBackend(root)
    broker = Broker(root, backend)
    broker.create({"environmentId": "env", "scope": "scope", "workspaceId": "ws", "resourceIds": ["desktop"],
                   "image": "example.org/tools@sha256:" + "1" * 64})
    binding = broker.acquire({"environmentId": "env", "scope": "scope", "workflowId": "flow", "ttlSeconds": 60})
    backend.request = {"environment": binding["environment"], "token": binding["token"], "scope": "scope",
                       "intentId": "intent", "attemptId": "attempt", "operationId": "op", "digest": "d" * 64,
                       "toolName": "shell.exec", "arguments": {}, "target": {}, "deadline": "2099-01-01T00:00:00Z"}
    broker.execute(backend.request)
