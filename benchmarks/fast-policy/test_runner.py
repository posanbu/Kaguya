"""用本地 HTTP/SSE 服务验证 benchmark 行为，不访问外部 Provider。

Server/Handler 生成可控流、拒绝访问、慢分片、截断和格式错误，记录真实同时在途数；
fixture 使用 Condition 等待 handler 收敛，使用 Barrier 确认并发请求重叠；
RunnerTests 验证 gold 隔离、12 条件矩阵、20并发上限、缺失usage、SLA分母、密钥
脱敏、私有输出和dry-run无网络。计时仅用于观察socket总deadline，非模型性能测试。
"""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import runner

FIXTURE_TIMEOUT = 5.0
TEST_KEY = "test-only-placeholder"
DECISION = {"action": "message", "intent": "answer", "provide": ["I1"], "avoid": []}


def sample():
    context = {"information": [{"id": "I1", "text": "test-only information"}]}
    return {"id": "test-case", "contexts": {level: copy.deepcopy(context) for level in runner.CONTEXTS},
            "gold": {"action": "message", "intent": "answer", "required_information": ["I1"], "forbidden_information": []}}


def spec(model="ok", thinking="off"):
    result = runner.build_schedule([sample()], [("flash", model)], 1, 181)[0]
    result["thinking"] = thinking
    return result


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.active = 0
        self.inflight = 0
        self.maximum = 0
        self.lock = threading.Condition()
        self.parallel_barrier = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass

    def do_POST(self):
        with self.server.lock:
            self.server.active += 1
            self.server.inflight += 1
            self.response_finished = False
            self.server.maximum = max(self.server.maximum, self.server.inflight)
        try:
            self.respond()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with self.server.lock:
                self.server.active -= 1
                if not self.response_finished:
                    self.server.inflight -= 1
                self.server.lock.notify_all()

    def event(self, value):
        if value == "[DONE]":
            # [DONE] 之后客户端可立即开始下一请求；handler 的收尾单独由 active 跟踪。
            with self.server.lock:
                if not self.response_finished:
                    self.server.inflight -= 1
                    self.response_finished = True
        data = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        self.wfile.write(("data: " + data + "\n\n").encode())
        self.wfile.flush()

    def respond(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        model = body["model"]
        if model == "blocked":
            self.send_response(403)
            self.end_headers()
            self.wfile.write(self.headers.get("Authorization", "").encode())
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if model == "slow":
            for _ in range(40):
                self.wfile.write(b":keepalive\n\n")
                self.wfile.flush()
                time.sleep(.01)
            return
        if model == "parallel":
            self.server.parallel_barrier.wait(timeout=FIXTURE_TIMEOUT)
        if body["thinking"]["type"] == "enabled":
            self.event({"id": "test-id", "model": model, "choices": [{"index": 0, "delta": {"reasoning_content": "test-only reasoning"}}]})
        text = "invalid policy" if model == "bad-json" else json.dumps(DECISION)
        if model == "split-unicode":
            # Unicode kept in an SSE metadata field; UTF-8 split between socket reads.
            packet = ('data: '+json.dumps({"metadata": "测试", "choices": []}, ensure_ascii=False)+'\n\n').encode()
            pos = packet.index('测'.encode())+1
            self.wfile.write(packet[:pos]); self.wfile.flush()
            self.wfile.write(packet[pos:]); self.wfile.flush()
        for part in (text[:20], text[20:]):
            self.event({"id": "test-id", "model": model, "choices": [{"index": 0, "delta": {"content": part}}]})
        if model == "trailing":
            self.event({"choices": [{"index": 0, "delta": {"content": " trailing invalid data"}}]})
        reason = "length" if model == "truncated" else "stop"
        self.event({"choices": [{"index": 0, "delta": {}, "finish_reason": reason}]})
        if model != "no-usage":
            self.event({"choices": [], "usage": {"prompt_tokens": 22, "completion_tokens": 31, "total_tokens": 53}})
        if model != "incomplete": self.event("[DONE]")


class RunnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Server(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=FIXTURE_TIMEOUT)
        if cls.thread.is_alive():
            raise AssertionError("HTTP server thread did not stop")

    def tearDown(self):
        if self.server.parallel_barrier is not None:
            self.server.parallel_barrier.abort()
        with self.server.lock:
            self.assertTrue(self.server.lock.wait_for(
                lambda: self.server.active == 0, timeout=FIXTURE_TIMEOUT),
                "HTTP handlers did not finish before the next test")
        self.server.parallel_barrier = None

    def execute(self, model="ok", thinking="off", timeout=FIXTURE_TIMEOUT):
        return runner.execute_attempt(spec(model, thinking), self.base_url, TEST_KEY, timeout)

    def test_sse_event_multiline_comments_and_truncation(self):
        lines = [b': ping\r\n', b'data: {\r\n', b'data: "x":1}\r\n', b'\r\n']
        self.assertEqual(json.loads(list(runner.parse_sse(lines))[0]), {"x": 1})
        with self.assertRaises(ValueError): list(runner.parse_sse([b'data: {}\n']))

    def test_stream_usage_and_separate_reasoning_clock(self):
        row = self.execute(thinking="low")
        self.assertTrue(row["valid"])
        self.assertEqual(row["response_model"], "ok")
        self.assertEqual(row["decision"], DECISION)
        self.assertLessEqual(row["first_reasoning_s"], row["first_content_s"])
        self.assertLessEqual(row["decision_latency_s"], row["total_latency_s"])
        self.assertEqual(row["normalized_usage"]["prompt_tokens"], 22)
        self.assertIsNone(row["normalized_usage"]["reasoning_tokens"])
        self.assertTrue(row["events"])

    def test_missing_usage_stays_unknown(self):
        row = self.execute("no-usage")
        self.assertTrue(row["valid"])
        self.assertTrue(all(value is None for value in row["normalized_usage"].values()))
        summary = runner.summarize([row])
        self.assertEqual(summary["overall"]["usage"]["reasoning_tokens"]["observed"], 0)
        self.assertIsNone(summary["overall"]["usage"]["reasoning_tokens"]["mean"])

    def test_incomplete_invalid_truncated_and_late_content_are_not_completed(self):
        for model in ("incomplete", "bad-json", "truncated", "trailing"):
            with self.subTest(model=model):
                row = self.execute(model)
                self.assertFalse(row["valid"])
                self.assertEqual(runner.summarize([row])["overall"]["budgets"]["10"]["valid_completed"], 0)
        self.assertIsNone(self.execute("trailing")["decision_latency_s"])

    def test_utf8_fragmentation(self):
        self.assertTrue(self.execute("split-unicode")["valid"])

    def test_total_timeout_survives_continuous_keepalives(self):
        row = self.execute("slow", timeout=.065)
        self.assertFalse(row["valid"])
        self.assertEqual(row["error"]["type"], "timeout")
        self.assertLess(row["total_latency_s"], .35)

    def test_http_error_preserved_and_secret_redacted(self):
        row = self.execute("blocked")
        self.assertEqual(row["http_status"], 403)
        self.assertFalse(row["valid"])
        self.assertIn("[REDACTED]", row["http_error_body"])
        self.assertNotIn(TEST_KEY, json.dumps(row))

    def test_schema_rejects_extra_fields_unknown_duplicate_overlapping_ids(self):
        for change in ({"explanation": "x"}, {"provide": ["unknown"]}, {"provide": ["I1", "I1"]}, {"avoid": ["I1"]}):
            value = {**DECISION, **change}
            self.assertIsNone(runner.validate_decision(json.dumps(value), {"I1"})[0])

    def test_schedule_has_paired_matrix_and_reproducible_order(self):
        models = [("flash", "test-flash"), ("pro", "test-pro")]
        a = runner.build_schedule([sample()], models, 2, 181)
        b = runner.build_schedule([sample()], models, 2, 181)
        self.assertEqual(a, b)
        self.assertEqual(len(a), 24)
        for repeat in (0,1):
            self.assertEqual(len({(x["model"],x["thinking"],x["context"]) for x in a if x["repeat"] == repeat}), 12)

    def test_quality_deadline_uses_all_labeled_attempts_and_no_gold_is_null(self):
        row = self.execute()
        row["total_latency_s"] = 3
        failed = copy.deepcopy(row)
        failed["valid"] = False
        summary = runner.summarize([row, failed])["overall"]
        self.assertEqual(summary["quality"]["action_correct_rate"], .5)
        self.assertEqual(summary["completed_only_quality"]["action_correct_rate"], 1)
        self.assertEqual(summary["budgets"]["2"]["quality"]["action_correct_rate"], 0)
        self.assertEqual(summary["budgets"]["10"]["quality"]["action_correct_rate"], .5)
        row["gold"] = None
        self.assertIsNone(runner.quality_metrics([row])["joint_correct_rate"])

    def test_information_selection_metrics_detect_forbidden_and_unnecessary_items(self):
        row = self.execute()
        row["decision"] = {**DECISION, "provide": ["I1", "I2"]}
        row["gold"]["forbidden_information"] = ["I2"]
        metrics = runner.quality_metrics([row])
        self.assertEqual(metrics["provide_macro_precision"], .5)
        self.assertEqual(metrics["provide_macro_recall"], 1)
        self.assertEqual(metrics["unnecessary_information_rate"], .5)
        self.assertEqual(metrics["forbidden_information_message_rate"], 1)

    def args(self, dataset, output, *extras):
        return runner.argument_parser().parse_args(["--dataset", str(dataset), "--output", str(output), *extras])

    def test_dry_run_has_no_network_or_key_reads_and_never_sends_gold(self):
        with tempfile.TemporaryDirectory() as folder:
            dataset = Path(folder)/"cases.jsonl"
            row = sample()
            row["gold"]["annotation_note"] = "DO_NOT_SEND_GOLD"
            dataset.write_text(json.dumps(row)+"\n")
            output = Path(folder)/"dry"
            args = self.args(dataset, output, "--dry-run", "--ask-api-key")
            with patch.object(runner.urllib.request, "urlopen", side_effect=AssertionError("network forbidden")), patch.object(runner.getpass, "getpass", side_effect=AssertionError("key read forbidden")):
                runner.run(args)
            requests = (output/"requests.jsonl").read_text()
            self.assertNotIn("DO_NOT_SEND_GOLD", requests)
            self.assertNotIn('"gold"', requests)
            self.assertEqual(len(requests.splitlines()), 12)
            manifest = json.loads((output/"manifest.json").read_text())
            self.assertEqual(manifest["status"], "dry_run_complete")
            with self.assertRaises(FileExistsError): runner.run(args)

    def test_interruption_records_incomplete_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            dataset = Path(folder)/"cases.jsonl"
            dataset.write_text(json.dumps(sample())+"\n")
            output = Path(folder)/"interrupted"
            args = self.args(dataset, output, "--models", "flash", "--concurrency", "1")
            with patch.dict(os.environ, {"API_KEY": TEST_KEY}), patch.object(runner, "execute_attempt", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt): runner.run(args)
            manifest = json.loads((output/"manifest.json").read_text())
            self.assertEqual(manifest["status"], "interrupted")
            self.assertLess(manifest["completed_attempts"], manifest["planned_attempts"])

    def test_concurrency_cap_rejected_before_network_and_observed_locally(self):
        with tempfile.TemporaryDirectory() as folder:
            dataset = Path(folder)/"cases.jsonl"
            dataset.write_text(json.dumps(sample())+"\n")
            for value in (0,21):
                args = self.args(dataset,Path(folder)/f"bad-{value}","--concurrency",str(value),"--dry-run")
                with self.assertRaises(ValueError): runner.run(args)
            with self.server.lock:
                self.assertTrue(self.server.lock.wait_for(
                    lambda: self.server.active == 0, timeout=FIXTURE_TIMEOUT),
                    "HTTP handlers were still active before concurrency measurement")
                self.server.maximum = 0
                self.server.parallel_barrier = threading.Barrier(3)
            args = self.args(dataset,Path(folder)/"run","--base-url",self.base_url,"--models","flash","--flash-model","parallel","--concurrency","3","--timeout",str(FIXTURE_TIMEOUT * 2))
            with patch.dict(os.environ,{"API_KEY": TEST_KEY}), patch("sys.stderr",new=io.StringIO()):
                summary = runner.run(args)
            self.assertEqual(summary["overall"]["attempts"], 6)
            self.assertEqual(summary["overall"]["valid"], 6)
            self.assertLessEqual(self.server.maximum, 3)
            self.assertGreater(self.server.maximum, 1)
            output = Path(folder)/"run"
            manifest = json.loads((output/"manifest.json").read_text())
            self.assertEqual(manifest["completed_attempts"], manifest["planned_attempts"])
            self.assertNotIn(TEST_KEY, (output/"samples.jsonl").read_text())
            if os.name != "nt":
                self.assertEqual(output.stat().st_mode & 0o777, 0o700)
                for file in output.iterdir(): self.assertEqual(file.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__": unittest.main()
