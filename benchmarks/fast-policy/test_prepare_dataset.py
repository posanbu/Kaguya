"""验证真实冻结请求的离线适配边界，不访问生产数据、网络或 API 密钥。

build_source 提供仅含虚构占位文本的 CompiledPrompt；测试保证三档子集嵌套、信息
选择空间相同、历史模型输出不进入新请求，以及缺失变量不会静默变成有效样本。
文件测试在全部平台检查 0600 与独占创建参数、内容完整及拒绝覆盖；实际权限位
仅在 POSIX 检查。Windows 的 stat 不表达 POSIX 私有位，沿用 exporter 的平台边界。
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from prepare_dataset import build_case, prepare


def build_source():
    values = {
        "current_time": {"iso": "2026-01-01T00:00:00Z"}, "identity": {"name": "Test agent"},
        "conversation": {"background": {}, "resolution": {}},
        "turn": {"inputs": [{"text": "test-only current input"}], "attempt": 0, "totalWaitBudget": 3},
        "history": [{"text": f"test-only history {i}"} for i in range(12)],
        "memory": [f"test-only memory {i}" for i in range(6)],
    }
    return {"id": "case-1", "source_request_id": "source-1", "occurred_at": "2026-01-01T00:00:00Z",
            "prompt": {"variables": [{"name": k, "content": json.dumps(v)} for k,v in values.items()],
                       "templateId": "test-only-template", "text": "test-only prompt"},
            "result": "FORBIDDEN_OLD_MODEL_RESULT"}


class PrepareTests(unittest.TestCase):
    def test_nested_real_subsets_and_constant_current_scene(self):
        case = build_case(build_source())
        compact, medium, long = (case["contexts"][k] for k in ("compact", "medium", "long"))
        self.assertEqual(compact["history"], medium["history"][-2:])
        self.assertEqual(medium["history"], long["history"][-8:])
        self.assertEqual(medium["memory"], long["memory"][:4])
        for field in ("information", "turn", "identity", "conversation", "current_time"):
            self.assertEqual(compact[field], medium[field])
            self.assertEqual(medium[field], long[field])
        self.assertIsNone(case["gold"])
        self.assertNotIn("FORBIDDEN_OLD_MODEL_RESULT", json.dumps(case))

    def test_missing_or_duplicate_frozen_variables_rejected(self):
        source = build_source()
        source["prompt"]["variables"].pop()
        with self.assertRaises(ValueError): build_case(source)
        source = build_source()
        source["prompt"]["variables"].append(source["prompt"]["variables"][0])
        with self.assertRaises(ValueError): build_case(source)

    def test_no_synthetic_padding_and_no_accidental_overwrite(self):
        source = build_source()
        for variable in source["prompt"]["variables"]:
            if variable["name"] in ("memory", "history"): variable["content"] = "[]"
        case = build_case(source)
        self.assertEqual(case["contexts"]["compact"], case["contexts"]["long"])
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"source.jsonl"
            path.write_text(json.dumps(source)+"\n")
            output = Path(folder)/"dataset"
            with patch("prepare_dataset.os.open", wraps=os.open) as create:
                meta = prepare(path, output)
            create.assert_any_call(output / "cases.jsonl", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            self.assertEqual(meta["samples"], 1)
            self.assertEqual(meta["gold_samples"], 0)
            self.assertEqual(meta["identical_context_cases"]["compact:long"], 1)
            original = (output / "cases.jsonl").read_bytes()
            self.assertEqual(json.loads(original)["id"], "case-1")
            if os.name == "posix":
                self.assertEqual((output/"cases.jsonl").stat().st_mode & 0o777, 0o600)
            with self.assertRaises(ValueError): prepare(path, output)
            self.assertEqual((output / "cases.jsonl").read_bytes(), original)


if __name__ == "__main__": unittest.main()
