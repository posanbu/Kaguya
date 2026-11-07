"""功能概述：GUI 验收脚本的只读条件等待，不启动进程或发布 fixture 数据。
主要职责：wait_for_command 重试尚未发布、空/残缺 JSON 与未满足的应用条件；成功必须在总预算内。
代码库关系：check-gui-container.py 注入有超时诊断的 Podman command；check_gui_readiness.py 验证时序。
输入输出与副作用：每次命令以剩余预算为上限；只等待观察条件，不重复输入。超时保留最后读状态。
"""
import json
import time


def wait_for_command(command, parts, seconds=15, predicate=None):
    deadline = time.monotonic() + seconds
    last = {"state": "not-read"}
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError({"guiReadinessTimeout": parts, "lastRead": last})
        result = command(*parts, check=False, timeout=min(30, remaining))
        last = {"exitCode": result.returncode, "bytes": len(result.stdout),
                "stderr": result.stderr.decode(errors="replace")[-512:]}
        ready = False
        if result.returncode == 0:
            if predicate is None:
                value, ready = result.stdout, True
            else:
                try:
                    value = json.loads(result.stdout)
                except (json.JSONDecodeError, UnicodeDecodeError) as error:
                    last["decodeError"] = str(error)
                else:
                    last["value"] = value
                    ready = predicate(value)
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RuntimeError({"guiReadinessTimeout": parts, "lastRead": last})
        if ready:
            return value
        time.sleep(min(.02, remaining))
