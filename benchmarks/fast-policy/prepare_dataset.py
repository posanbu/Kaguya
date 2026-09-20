#!/usr/bin/env python3
"""从只读导出的真实 Planner 请求构建 fast-policy probe 的三档上下文。

功能概述：此离线适配器连接 export_workload.mjs 与 runner.py，不调用模型、不生成
标准答案，也不把旧模型结果当作标签。build_case 解析首次冻结的 CompiledPrompt
变量，保留身份、当前输入、会话关系和时间；按固定条数嵌套加入历史与记忆。
prepare 将所有真实请求逐条转换，输出私有 JSONL 和包含哈希、计数、上下文增量的
manifest；任何缺失或不合法变量使整个转换失败，不静默丢弃困难样本。
输入输出与副作用：输入 source-private.jsonl；输出目录必须为空或不存在，目录
权限 0700、文件 0600。原始正文仅写私有数据文件，stdout 只显示计数和哈希。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path

CONTEXT_LIMITS = {"compact": (2, 0), "medium": (8, 4), "long": (None, None)}
REQUIRED_VARIABLES = {"current_time", "identity", "turn", "conversation", "history", "memory"}


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_private(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


def build_case(source: dict) -> dict:
    variables = source["prompt"]["variables"]
    names = [v["name"] for v in variables]
    if len(names) != len(set(names)) or not REQUIRED_VARIABLES.issubset(names):
        raise ValueError("missing or duplicate frozen prompt variables")
    values = {v["name"]: json.loads(v["content"]) for v in variables}
    if not isinstance(values["history"], list) or not isinstance(values["memory"], list):
        raise ValueError("history and memory must be frozen arrays")
    if not isinstance(values["turn"], dict) or not values["turn"].get("inputs"):
        raise ValueError("frozen turn must contain inputs")
    contexts = {}
    for level, (history_limit, memory_limit) in CONTEXT_LIMITS.items():
        histories = values["history"] if history_limit is None else values["history"][-history_limit:]
        memories = values["memory"] if memory_limit is None else values["memory"][:memory_limit]
        information = [
            {"id": f"I{i}", "origin": "current_input", "text": item["text"]}
            for i, item in enumerate(values["turn"]["inputs"])
        ]
        # 候选信息集合固定为当前输入；新增历史与记忆只作为判断依据，避免改变选择空间。
        contexts[level] = {
            "current_time": values["current_time"], "identity": values["identity"],
            "turn": values["turn"], "conversation": values["conversation"],
            "history": histories, "memory": memories, "information": information,
        }
    source_id = source["id"]
    return {
        "id": source_id,
        "provenance": {"kind": "production", "source_request_id_hash": digest(str(source.get("source_request_id", source_id)).encode()),
                       "occurred_at": source.get("occurred_at"), "source_template": source["prompt"]["templateId"],
                       "source_prompt_sha256": digest(source["prompt"]["text"].encode()),
                       "adapter": "nested-history-memory/v1"},
        "contexts": contexts,
        "gold": None,
    }


def prepare(source_path: Path, output_dir: Path) -> dict:
    raw = source_path.read_bytes()
    sources = [json.loads(line) for line in raw.splitlines() if line.strip()]
    cases = [build_case(source) for source in sources]
    if not cases or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("dataset must be nonempty with unique ids")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ValueError("refusing to overwrite existing dataset")
    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output_dir, 0o700)
    data = ("\n".join(json.dumps(case, ensure_ascii=False, separators=(",", ":")) for case in cases)+"\n").encode()
    target = output_dir / "cases.jsonl"
    write_private(target, data)
    context_summary = {}
    for level in CONTEXT_LIMITS:
        sizes = [len(json.dumps(c["contexts"][level], ensure_ascii=False)) for c in cases]
        context_summary[level] = {"characters_min": min(sizes), "characters_max": max(sizes),
                                  "characters_mean": sum(sizes)/len(sizes),
                                  "history_items": sum(len(c["contexts"][level]["history"]) for c in cases),
                                  "memory_items": sum(len(c["contexts"][level]["memory"]) for c in cases)}
    manifest = {"schema_version": 1, "protocol": "kaguya-fast-policy-probe/v1", "source_sha256": digest(raw),
                "dataset_sha256": digest(data), "samples": len(cases), "gold_samples": 0,
                "context_limits": CONTEXT_LIMITS, "context_summary": context_summary,
                "identical_context_cases": {f"{a}:{b}":sum(c["contexts"][a] == c["contexts"][b] for c in cases)
                                             for a,b in [("compact","medium"),("medium","long"),("compact","long")]},
                "limitations": ["no independent gold labels", "custom probe, not production Planner replay",
                                "information selection restricted to current-input IDs", "context levels are available-data subsets, not fixed token budgets"]}
    manifest_path = output_dir/"dataset-manifest.json"
    write_private(manifest_path, (json.dumps(manifest, ensure_ascii=False, indent=2)+"\n").encode())
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(prepare(args.source, args.output), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
