"""验证显式 API 预检的请求数、失败退出和密钥处理，所有网络调用均替换为本地桩。

测试调用 preflight.main 的 CLI 边界；假 execute_attempt 只返回固定数据，不调用
API，不读取生产配置。用于保证四条件预检不会扩展为完整真实数据实验。
"""
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import preflight


class PreflightTests(unittest.TestCase):
    def test_four_sequential_probes_and_denied_model_is_failure(self):
        calls = []
        def fake_execute(spec, base, key, timeout):
            calls.append(spec)
            return {"model_family": spec["model_family"], "thinking": spec["thinking"],
                    "http_status": 403 if spec["model_family"] == "pro" else 200,
                    "valid": spec["model_family"] != "pro", "reasoning_text": ""}
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/"preflight"
            with patch("sys.argv", ["preflight.py", "--output", str(output)]), patch.dict(os.environ, {"API_KEY": "test-only-placeholder"}), patch.object(preflight,"execute_attempt",side_effect=fake_execute), patch.object(preflight,"summarize",return_value={}), patch("sys.stdout",new=io.StringIO()):
                self.assertEqual(preflight.main(), 1)
            self.assertEqual(len(calls), 4)
            self.assertEqual({(s["model_family"],s["thinking"]) for s in calls}, {("flash","off"),("flash","low"),("pro","off"),("pro","low")})
            self.assertTrue(all(s["sample"]["provenance"]["kind"] == "synthetic-preflight" for s in calls))
            saved = (output/"preflight.json").read_text()
            self.assertNotIn("test-only-placeholder", saved)
            self.assertTrue(json.loads(saved)["not_benchmark_data"])


if __name__ == "__main__": unittest.main()
