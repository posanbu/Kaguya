#!/usr/bin/env python3
"""功能概述：离线参与评测 CLI，串联 core.py 的冻结与 baseline.py 的统计评分。

主要职责：prepare 命令读取版本化 journal/config 并分开写 inputs、labels、sources；
preview 只读取输入及校验清单，不打开标签，写出完整候选请求；evaluate 验证清单
后训练历史统计、选择 dev 阈值并报告 test。write_bundle 以独占目录防覆盖，
verify_bundle 校验协议和工件哈希；main 是唯一命令入口。
代码库关系：与 fast-policy 工具采用一致的 schema_version/source_sha256/
dataset_sha256 清单字段；本工具保持独立，不修改原工具、生产库或 Prompt。
输入输出与副作用：仅访问命令指定的本地文件；输出目录 0700、文件 0600
（POSIX），Windows 使用账户 ACL。不读取 API key、联网或启动后台任务。
输出未完成时保留 incomplete.json；读取时拒绝缺失或被修改的工件。
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from baseline import evaluate as evaluate_policy
from core import PROTOCOL, digest, encoded, load_corpus, prepare_samples

ROOT = Path(__file__).resolve().parent


def code_hash() -> str:
    return digest(b"".join(path.name.encode() + b"\0" + path.read_bytes() for path in sorted(ROOT.glob("*.py"))
                           if not path.name.startswith("test_")))


def jsonl(rows: list) -> bytes:
    return b"".join(encoded(row) for row in rows)


def write_private(path: Path, data: bytes) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(data)


def write_bundle(output: Path, files: dict[str, bytes], manifest: dict,
                 runtime_files: dict[str, bytes] | None = None) -> dict:
    # mkdir 的独占语义也拒绝已存在空目录，避免重复运行混入半成品。
    output.mkdir(parents=True, mode=0o700, exist_ok=False)
    os.chmod(output, 0o700)
    write_private(output / "incomplete.json", encoded({"status": "incomplete"}))
    for name, data in files.items():
        write_private(output / name, data)
    for name, data in (runtime_files or {}).items():
        write_private(output / name, data)
    result = {"schema_version": 1, "protocol": PROTOCOL, "code_sha256": code_hash(), **manifest,
              "artifacts": {name: digest(data) for name, data in sorted(files.items())}}
    write_private(output / "manifest.json", encoded(result))
    (output / "incomplete.json").unlink()
    return result


def verify_bundle(folder: Path, required: tuple[str, ...]) -> dict:
    if (folder / "incomplete.json").exists():
        raise ValueError("bundle is incomplete")
    meta = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    if meta["schema_version"] != 1 or meta["protocol"] != PROTOCOL:
        raise ValueError("unsupported bundle protocol")
    for name in required:
        if digest((folder / name).read_bytes()) != meta["artifacts"].get(name):
            raise ValueError(f"artifact hash mismatch: {name}")
    return meta


def read_rows(path: Path) -> list:
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def prepare(source: Path, config: Path, output: Path) -> dict:
    corpus, source_hash, config_hash = load_corpus(source, config)
    inputs, labels, counts = prepare_samples(corpus, source_hash, config_hash)
    files = {"inputs.jsonl": jsonl(inputs), "labels.jsonl": jsonl(labels),
             "sources.jsonl": jsonl(corpus.source_index), "config.json": encoded(corpus.config)}
    return write_bundle(output, files, {"stage": "prepared", "data_kind": corpus.config["dataKind"],
                        "source_sha256": source_hash, "config_sha256": config_hash,
                        "dataset_sha256": digest(files["inputs.jsonl"] + files["labels.jsonl"]),
                        "counts": counts})


def preview(dataset: Path, output: Path) -> dict:
    # 不读取 labels.jsonl 或 sources.jsonl，完整预览等于候选能够得到的全部输入。
    meta = verify_bundle(dataset, ("inputs.jsonl",))
    data = (dataset / "inputs.jsonl").read_bytes()
    return write_bundle(output, {"requests.jsonl": data}, {
        "stage": "preview", "data_kind": meta["data_kind"], "source_sha256": meta["source_sha256"],
        "dataset_sha256": meta["dataset_sha256"], "requests": meta["counts"]["samples"],
        "network_requests": 0})


def evaluate(dataset: Path, output: Path) -> dict:
    meta = verify_bundle(dataset, ("inputs.jsonl", "labels.jsonl", "config.json", "sources.jsonl"))
    inputs, labels = (read_rows(dataset / name) for name in ("inputs.jsonl", "labels.jsonl"))
    config = json.loads((dataset / "config.json").read_text(encoding="utf-8"))
    summary, predictions, runtime = evaluate_policy(inputs, labels, config["minGroupSamples"])
    summary.update(dataKind=meta["data_kind"], purpose="pipeline_validation" if meta["data_kind"] == "synthetic" else "private_participation_evaluation")
    files = {"predictions.jsonl": jsonl(predictions), "summary.json": encoded(summary)}
    return write_bundle(output, files, {"stage": "evaluated", "data_kind": meta["data_kind"],
                          "source_sha256": meta["source_sha256"], "dataset_sha256": meta["dataset_sha256"],
                          "prepared_code_sha256": meta["code_sha256"], "samples": len(inputs),
                          "network_requests": 0,
                          "runtime_metadata": "runtime.json (excluded from deterministic hashes)"},
                        {"runtime.json": encoded(runtime)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Kaguya offline participation benchmark (no network)")
    sub = parser.add_subparsers(dest="command", required=True)
    prep = sub.add_parser("prepare")
    prep.add_argument("--source", type=Path, required=True)
    prep.add_argument("--config", type=Path, required=True)
    prep.add_argument("--output", type=Path, required=True)
    for name in ("preview", "evaluate"):
        command = sub.add_parser(name)
        command.add_argument("--dataset", type=Path, required=True)
        command.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare":
            result = prepare(args.source, args.config, args.output)
        else:
            result = {"preview": preview, "evaluate": evaluate}[args.command](args.dataset, args.output)
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(2, f"{type(error).__name__}: {error}\n")
    print(encoded(result).decode("utf-8"), end="")


if __name__ == "__main__":
    main()
