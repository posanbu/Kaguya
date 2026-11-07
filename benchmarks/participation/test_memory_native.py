"""功能概述：验证 native Memory 请求/响应桥接的确定性及历史边界。

主要职责：使用虚构旧历史和本地响应检查来源、目标、水位、撤回及漏项；
检查来源元数据和未知字段，阻止附带未来信息，并验证复用 adapter 不改写已冻结样本。
验证 CLI 导出的请求无标签、近期正文与未来正文，默认基线仍标明不使用 Memory。
代码库关系：调用 memory_native、bench 和 core；这里的响应是显式测试替身，
真实数据库召回由 native-memory.test.ts 验证，不将替身计为 native 检索证据。
输入输出与副作用：临时目录由 unittest 清理；不启动模型、网络或数据库，无定时等待。
"""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from bench import ROOT, evaluate, memory_requests, prepare, read_rows
from core import Corpus, digest, encoded, prepare_samples, timestamp
from memory_native import NativeRequests, NativeSnapshots

SCOPE = {"platform": "qq", "adapterId": "fake", "accountId": "bot", "groupId": "room"}
HISTORY = [{"recordId": "old", "captureSeq": 1, "text": "合成旧消息", "retracted": False}]


def request(history=None):
    adapter = NativeRequests()
    checkpoint = adapter.build(SCOPE, 3, HISTORY if history is None else history)
    adapter.recall(checkpoint, "target")
    return checkpoint, next(iter(adapter.requests.values()))


def response(req):
    return {**{k: v for k, v in req.items() if k != "earlierHistory"},
            "evidence": [{"sourceIds": ["old"], "text": "合成旧消息"}],
            "metrics": {"networkRequests": 0}}


class NativeMemoryTests(unittest.TestCase):
    def with_response(self, row, callback):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "responses.jsonl"
            path.write_bytes(encoded(row))
            adapter = NativeSnapshots(path)
            return callback(adapter)

    def test_request_is_deterministic_target_bound_and_defensive(self):
        one, req = request()
        self.assertEqual(req, request()[1])
        adapter = NativeRequests()
        history = copy.deepcopy(HISTORY)
        checkpoint = adapter.build(SCOPE, 3, history)
        history[0]["text"] = "changed"
        adapter.recall(checkpoint, "target")
        adapter.recall(checkpoint, "other")
        self.assertEqual(len(adapter.requests), 2)
        self.assertIn(req, adapter.requests.values())
        with self.assertRaisesRegex(ValueError, "checkpoint"):
            adapter.recall({**one, "sourceWatermark": 4}, "target")

    def test_response_is_copied_and_missing_extra_or_duplicate_requests_fail(self):
        _, req = request()
        def use(adapter):
            checkpoint = adapter.build(SCOPE, 3, HISTORY)
            result = adapter.recall(checkpoint, "target")
            result[0]["text"] = "changed"
            self.assertEqual(adapter.recall(checkpoint, "target")[0]["text"], "合成旧消息")
            adapter.assert_complete()
            with self.assertRaisesRegex(ValueError, "missing"):
                adapter.recall(checkpoint, "other")
        self.with_response(response(req), use)
        with self.assertRaisesRegex(ValueError, "unused"):
            self.with_response(response(req), lambda adapter: adapter.assert_complete())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "duplicates.jsonl"
            path.write_bytes(encoded(response(req)) * 2)
            with self.assertRaisesRegex(ValueError, "duplicate"):
                NativeSnapshots(path)

    def test_wrong_binding_future_retracted_and_network_results_fail(self):
        _, req = request()
        for field, value in (("targetUser", "other"), ("scope", {**SCOPE, "groupId": "other"}),
                             ("sourceWatermark", 99), ("sourceWatermark", 3.0), ("sourceWatermark", True), ("prefixSha256", "other"), ("adapter", "empty/v1")):
            row = response(req)
            row[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "binding"):
                self.with_response(row, lambda a: a.recall(a.build(SCOPE, 3, HISTORY), "target"))
        for sources in (["future"], [], ["old", "future"]):
            row = response(req)
            row["evidence"][0]["sourceIds"] = sources
            with self.subTest(sources=sources), self.assertRaisesRegex(ValueError, "unretracted"):
                self.with_response(row, lambda a: a.recall(a.build(SCOPE, 3, HISTORY), "target"))
        retracted = [{**HISTORY[0], "text": None, "retracted": True}]
        row = response(request(retracted)[1])
        with self.assertRaisesRegex(ValueError, "unretracted"):
            self.with_response(row, lambda a: a.recall(a.build(SCOPE, 3, retracted), "target"))
        row = response(req)
        row["metrics"]["networkRequests"] = 1
        with self.assertRaisesRegex(ValueError, "zero network"):
            self.with_response(row, lambda a: a.recall(a.build(SCOPE, 3, HISTORY), "target"))

    def test_export_prepare_preview_and_report_binding_without_network(self):
        with tempfile.TemporaryDirectory() as folder, patch("socket.socket", side_effect=AssertionError("network")):
            root = Path(folder)
            source, config = ROOT / "example-events.jsonl", ROOT / "example-config.json"
            one = memory_requests(source, config, root / "one")
            self.assertEqual(one, memory_requests(source, config, root / "two"))
            requests = read_rows(root / "one" / "memory-requests.jsonl")
            self.assertGreater(len(requests), 0)
            self.assertNotIn("windows", str(requests))
            self.assertNotIn("participates", str(requests))
            # 空替身仅验证桥接装配，真实非空召回由 TypeScript 集成测试覆盖。
            rows = [{**response(req), "evidence": []} for req in requests]
            path = root / "native.jsonl"
            path.write_bytes(b"".join(encoded(row) for row in rows))
            meta = prepare(source, config, root / "data", path)
            self.assertEqual(meta["memory_adapter"], "native-extractive/v1")
            self.assertIsNotNone(meta["memory_responses_sha256"])
            evaluate(root / "data", root / "report")
            summary = json.loads((root / "report" / "summary.json").read_text())
            self.assertFalse(summary["predictorUsesMemory"])
            self.assertFalse(summary["memoryEffectEvaluated"])
            path.write_bytes(b"".join(encoded(row) for row in rows[1:]))
            with self.assertRaisesRegex(ValueError, "missing"):
                prepare(source, config, root / "missing", path)

    def test_source_metadata_and_extra_fields_cannot_smuggle_future_information(self):
        history = [{**HISTORY[0], "senderId": "target", "receivedAt": "2026-01-01T00:00:01Z",
                    "occurredAt": "2026-01-01T00:00:00Z", "mediaTypes": ["image"],
                    "replySourceId": None, "unresolvedReply": False}]
        req = request(history)[1]
        metadata = {key: history[0][key] for key in ("recordId", "senderId", "receivedAt", "occurredAt",
                                                    "mediaTypes", "replySourceId", "unresolvedReply")}
        metadata["missingMediaContent"] = True
        row = response(req)
        row["evidence"][0]["sources"] = [metadata]
        def recall(adapter):
            return adapter.recall(adapter.build(SCOPE, 3, history), "target")
        self.assertEqual(self.with_response(row, recall)[0]["sources"], [metadata])
        for field, value in (("recordId", "future"), ("senderId", "future-identity"),
                             ("receivedAt", "2099-01-01T00:00:00Z"), ("missingMediaContent", 1),
                             ("labels", {"participates": True})):
            bad = copy.deepcopy(row)
            bad["evidence"][0]["sources"][0][field] = value
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "source metadata"):
                self.with_response(bad, recall)
        bad = copy.deepcopy(row)
        bad["evidence"][0]["futureProfile"] = "FUTURE_SENTINEL"
        with self.assertRaisesRegex(ValueError, "unsupported fields"):
            self.with_response(bad, recall)

    def test_reused_memory_buffers_stay_bound_to_each_target_prefix_and_block(self):
        from test_core import config, event, coverage, scope
        cfg = config([{"scope": scope(), "userId": user} for user in ("a", "b")])
        cfg["recentMessages"] = 1
        corpus = Corpus([event(1, 0), event(2, 1, "b"), event(3, 601), event(4, 1201), coverage()], cfg)
        class ReusingMemory:
            def __init__(self):
                self.checkpoint, self.evidence, self.history = {}, [], []

            def build(self, scope, watermark, earlier):
                self.history = earlier
                self.checkpoint.update(scope=scope, sourceWatermark=watermark, prefixSha256=digest(encoded(earlier)))
                return self.checkpoint

            def recall(self, checkpoint, target):
                self.evidence[:] = ([{"sourceIds": [self.history[-1]["recordId"]], "text": target}] if self.history else [])
                return self.evidence

        adapter = ReusingMemory()
        inputs, labels, _ = prepare_samples(corpus, "source", "config", adapter)
        self.assertEqual({item["id"] for item in inputs}, {item["id"] for item in labels})
        for item in inputs:
            earlier = corpus.snapshot(item["scope"], timestamp(item["cutoff"]), item["sourceWatermark"])[:-1]
            self.assertEqual(item["memoryCheckpoint"]["prefixSha256"], digest(encoded(earlier)))
            self.assertEqual(item["memoryCheckpoint"]["sourceWatermark"], item["sourceWatermark"])
            expected = [{"sourceIds": [earlier[-1]["recordId"]], "text": item["targetUser"]}] if earlier else []
            self.assertEqual(item["memoryEvidence"], expected)
        self.assertEqual({item["split"] for item in inputs}, {"history", "dev", "test"})
        self.assertEqual({item["targetUser"] for item in inputs}, {"a", "b"})
        frozen = encoded(inputs)
        adapter.checkpoint.clear()
        adapter.evidence.append({"sourceIds": ["future"], "text": "future"})
        self.assertEqual(encoded(inputs), frozen)

    def test_all_adapters_must_reject_retracted_evidence(self):
        from test_core import config, event, coverage
        cfg = config()
        cfg["recentMessages"] = 1
        events = [event(1, 0), event(2, 1, "b"),
                  {**event(3, 2), "eventType": "recall", "platformMessageId": "m1"}, coverage()]
        class CitingRetracted(NativeRequests):
            def recall(self, checkpoint, target_user):
                return [{"sourceIds": [m["recordId"]], "text": "stale"}
                        for m in self._history if m.get("retracted")]
        with self.assertRaisesRegex(ValueError, "unretracted"):
            prepare_samples(Corpus(events, cfg), "source", "config", CitingRetracted())


if __name__ == "__main__":
    unittest.main()
