"""功能概述：验证 prepare→preview→evaluate 的文件边界与完整 CLI 流程。

主要职责：使用提交的合成示例，测试确定性清单、私有权限、独占目录、防篡改、
预览无需标签和未来哨兵隔离；阻止 socket 与环境凭据访问，保证离线命令边界。
CLI 子进程设置显式超时、检查退出码及输出工件，无固定 sleep 或异步 fixture。
代码库关系：调用 bench.py，重用仓库内 example-events/config；与三平台 CI
执行相同命令。临时目录由标准库清理，不改生产数据与用户配置。
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from bench import ROOT, evaluate, prepare, preview, read_rows
from core import timestamp


class CliTests(unittest.TestCase):
    def prepare(self, target):
        return prepare(ROOT / "example-events.jsonl", ROOT / "example-config.json", target)

    def test_deterministic_manifest_and_private_exclusive_outputs(self):
        with tempfile.TemporaryDirectory() as temp:
            first, second = Path(temp) / "a", Path(temp) / "b"
            one, two = self.prepare(first), self.prepare(second)
            self.assertEqual(one, two)
            self.assertGreater(one["counts"]["samples"], 0)
            self.assertEqual(one["counts"]["duplicateMessages"], 1)
            self.assertEqual((first / "inputs.jsonl").read_bytes(), (second / "inputs.jsonl").read_bytes())
            self.assertFalse((first / "incomplete.json").exists())
            if os.name == "posix":
                self.assertEqual(first.stat().st_mode & 0o777, 0o700)
                for path in first.iterdir():
                    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            with self.assertRaises(FileExistsError):
                self.prepare(first)
            existing = Path(temp) / "empty"
            existing.mkdir()
            with self.assertRaises(FileExistsError):
                self.prepare(existing)

    def test_preview_never_opens_labels_and_early_inputs_exclude_future_sentinels(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset, output = Path(temp) / "data", Path(temp) / "preview"
            self.prepare(dataset)
            (dataset / "labels.jsonl").unlink()
            (dataset / "sources.jsonl").unlink()
            meta = preview(dataset, output)
            self.assertEqual(meta["network_requests"], 0)
            requests = read_rows(output / "requests.jsonl")
            early = [r for r in requests if timestamp(r["cutoff"]) < timestamp("2026-01-01T00:25:00Z")]
            self.assertNotIn("SYNTHETIC_FUTURE", str(early))
            self.assertNotIn("participates", str(requests))
            self.assertNotIn("windows", str(requests))

    def test_evaluate_detects_tampering_and_incomplete_bundles(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset = Path(temp) / "data"
            self.prepare(dataset)
            (dataset / "incomplete.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "incomplete"):
                preview(dataset, Path(temp) / "preview")
            (dataset / "incomplete.json").unlink()
            with (dataset / "labels.jsonl").open("ab") as stream:
                stream.write(b"\n")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                evaluate(dataset, Path(temp) / "out")

    def test_offline_without_credentials_and_repeated_evaluation_content_hashes(self):
        with tempfile.TemporaryDirectory() as temp, patch("socket.socket", side_effect=AssertionError("network")), \
                patch.dict(os.environ, {}, clear=True):
            dataset = Path(temp) / "data"
            self.prepare(dataset)
            one = evaluate(dataset, Path(temp) / "one")
            two = evaluate(dataset, Path(temp) / "two")
            self.assertEqual(one, two)
            self.assertNotIn("runtime.json", one["artifacts"])
            summary = json.loads((Path(temp) / "one" / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["purpose"], "pipeline_validation")
            self.assertEqual(len(summary["groups"]), 18)
            self.assertTrue(all(g["failures"] == 0 for g in summary["groups"]))

    def test_subprocess_cli_and_nonzero_exit_on_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            dataset = Path(temp) / "data"
            base = [sys.executable, str(ROOT / "bench.py")]
            commands = [base + ["prepare", "--source", str(ROOT / "example-events.jsonl"),
                               "--config", str(ROOT / "example-config.json"), "--output", str(dataset)],
                        base + ["preview", "--dataset", str(dataset), "--output", str(Path(temp) / "preview")],
                        base + ["evaluate", "--dataset", str(dataset), "--output", str(Path(temp) / "report")]]
            for command in commands:
                result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout)["protocol"], "kaguya-participation/v1")
            result = subprocess.run(commands[0], capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 2)
            self.assertIn("FileExistsError", result.stderr)


if __name__ == "__main__":
    unittest.main()
