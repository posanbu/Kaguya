#!/usr/bin/env python3
"""在正式测量前检查 API 的模型授权、SSE、JSON 和 thinking 参数兼容性。

功能概述：为 runner.py 提供显式且独立的最小探针，避免无权限模型产生整批失败。
main 使用与正式实验相同的 build_request/execute_attempt，按顺序发送最多四次
虚构上下文请求，不读取真实工作负载。输出私有 preflight.json，记录完整探针结果；
stdout 仅报告模型、HTTP 状态、有效性和推理信号。失败退出码为 1，不回退模型。
依赖与边界：只依赖同目录 runner.py；密钥来自 API_KEY、私有文件或隐藏终端输入。
这是会调用 API 的命令，不属于 unittest 或 dry-run。测试成功只说明协议可用，
并不能证明服务端忠实执行 reasoning_effort 或模型别名代表某一权重版本。
"""
from __future__ import annotations

import argparse
import getpass
import math
import os
from pathlib import Path

from runner import build_schedule, execute_attempt, private_json, summarize, utc_now


def probe_sample() -> dict:
    context = {
        "scene": "离线测试夹具：用户明确请求机器人告知活动开始时间。",
        "information": [{"id": "I1", "text": "活动于下午三点开始。"}],
    }
    return {"id": "synthetic-preflight", "provenance": {"kind": "synthetic-preflight"},
            "contexts": {level: context for level in ("compact", "medium", "long")}, "gold": None}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--base-url", default="https://api.llm.ustc.edu.cn/v1")
    parser.add_argument("--flash-model", default="deepseek-flash")
    parser.add_argument("--pro-model", default="deepseek-v4-pro")
    parser.add_argument("--models", choices=("all", "flash", "pro"), default="all")
    parser.add_argument("--timeout", type=float, default=60)
    credentials = parser.add_mutually_exclusive_group()
    credentials.add_argument("--api-key-file", type=Path)
    credentials.add_argument("--ask-api-key", action="store_true")
    args = parser.parse_args()
    if args.timeout <= 0 or not math.isfinite(args.timeout):
        parser.error("timeout must be finite and positive")
    if args.ask_api_key:
        key = getpass.getpass("API key (hidden): ").strip()
    elif args.api_key_file:
        key = args.api_key_file.read_text().strip()
    else:
        key = os.environ.get("API_KEY", "").strip()
    if not key or "\n" in key or "\r" in key:
        parser.error("a single nonempty API key is required")
    models = []
    if args.models in ("all", "flash"): models.append(("flash", args.flash_model))
    if args.models in ("all", "pro"): models.append(("pro", args.pro_model))
    if any(not model for _, model in models): parser.error("model names must not be empty")
    args.output.mkdir(parents=True, exist_ok=False, mode=0o700)
    schedule = [spec for spec in build_schedule([probe_sample()], models, 1, 181) if spec["context"] == "compact"]
    rows = []
    for spec in schedule:
        row = execute_attempt(spec, args.base_url, key, args.timeout)
        rows.append(row)
        print(f"{row['model_family']}/{row['thinking']}: HTTP={row['http_status']} valid={row['valid']} reasoning_observed={bool(row['reasoning_text'])}")
    private_json(args.output/"preflight.json", {"created_at": utc_now(), "not_benchmark_data": True,
                 "attempts": rows, "summary": summarize(rows)})
    return 0 if all(row["valid"] for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
