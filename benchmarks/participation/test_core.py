"""功能概述：用虚构 journal 验证冻结、标签与离线 Memory 的时间/范围边界。

主要职责：scope/event/config/fixture 为纯内存样例工厂；CorpusTests 覆盖窗口
末端、同时到达、迟到、去重、撤回和未解析引用；SamplesTests 检查分块、角色
转换、未来正文/昵称隔离，以及 Memory 只可引用更早同群来源。
代码库关系：只调用 core.py，不使用生产数据库、网络、异步 runner 或 timer。
输入输出与副作用：全部为合成身份；测试彼此独立，不读取用户会话。
"""
import copy
import unittest

from core import (Corpus, EmptyMemory, SECOND, digest, encoded, iso, prepare_samples,
                  timestamp, validate_prediction)

BASE = timestamp("2026-01-01T00:00:00Z")


def scope(group="group-a"):
    return dict(platform="qq", adapterId="demo", accountId="bot", groupId=group)


def at(seconds):
    return iso(BASE + seconds * SECOND)


def event(seq, seconds, sender="a", text="fictional", group="group-a", **fields):
    return dict(schemaVersion=1, recordId=f"r{seq}", captureSeq=seq, receivedAt=at(seconds),
                occurredAt=at(seconds), scope=scope(group), eventType="message",
                platformMessageId=f"m{seq}", senderId=sender, text=text, **fields)


def config(targets=None):
    return dict(schemaVersion=1, dataKind="synthetic", targets=targets or [dict(scope=scope(), userId="a")],
                blocks=[dict(id=f"b{i}", split=split, start=at(i * 600), end=at((i + 1) * 600))
                        for i, split in enumerate(("history", "dev", "test"))])


def coverage(seq=100, end=1800, start=0, status="complete", group="group-a"):
    e = event(seq, 1800, group=group)
    e.update(eventType="coverage", start=at(start), end=at(end), status=status)
    return e


def fixture():
    return [event(1, 0, "b"), event(2, 30), event(3, 120), event(4, 200, "b"),
            event(5, 230, "b"), event(6, 350), coverage()]


class CorpusTests(unittest.TestCase):
    def test_inclusive_window_end_delay_and_intervening_messages(self):
        corpus = Corpus(fixture(), config())
        label = corpus.label(scope(), "a", BASE, 1)
        self.assertTrue(label["windows"]["30"]["participates"])
        self.assertEqual(label["firstMessageDelaySeconds"], 30)
        self.assertEqual(label["interveningMessages"], 0)
        label = corpus.label(scope(), "a", BASE + 230 * SECOND, 5)
        self.assertFalse(label["windows"]["30"]["participates"])
        self.assertTrue(label["windows"]["120"]["participates"])
        self.assertEqual(label["firstMessageDelaySeconds"], 120)

    def test_same_timestamp_uses_watermark_not_occurrence_time(self):
        events = [event(1, 10, "b"), event(2, 10), event(3, 11)]
        events[2]["occurredAt"] = at(-100)
        corpus = Corpus(events + [coverage()], config())
        self.assertEqual(len(corpus.snapshot(scope(), BASE + 10 * SECOND, 1)), 1)
        self.assertEqual(corpus.label(scope(), "a", BASE + 10 * SECOND, 1)["firstMessageDelaySeconds"], 0)
        self.assertEqual(len(corpus.snapshot(scope(), BASE + 10 * SECOND, 2)), 2)
        self.assertEqual(len(corpus.snapshot(scope(), BASE + 11 * SECOND, 3)), 3)

    def test_gap_positive_unknown_negative_and_tail_censoring(self):
        corpus = Corpus([event(1, 0, "b"), event(2, 40), coverage(100, 100),
                         coverage(101, 35, 10, "gap")], config())
        label = corpus.label(scope(), "a", BASE, 1)
        self.assertIsNone(label["windows"]["30"]["participates"])
        self.assertTrue(label["windows"]["120"]["participates"])
        self.assertFalse(label["windows"]["120"]["coverageComplete"])
        self.assertIsNone(label["firstMessageDelaySeconds"])
        self.assertIsNone(label["interveningMessages"])
        self.assertEqual(label["delayStatus"], "censored")
        self.assertLess(label["delayObservationUpperBoundSeconds"], 10)
        label = corpus.label(scope(), "a", BASE + 90 * SECOND, 2)
        self.assertIsNone(label["windows"]["30"]["participates"])
        self.assertEqual(label["delayObservationUpperBoundSeconds"], 10)

    def test_simultaneous_positive_without_coverage_does_not_invent_delay(self):
        corpus = Corpus([event(1, 0, "b"), event(2, 0)], config())
        label = corpus.label(scope(), "a", BASE, 1)
        self.assertTrue(label["windows"]["30"]["participates"])
        self.assertIsNone(label["firstMessageDelaySeconds"])

    def test_adjacent_coverage_merges_but_a_gap_cannot_be_bridged(self):
        source = [event(1, 0, "b"), coverage(100, 60), coverage(101, 120, 60)]
        corpus = Corpus(source, config())
        self.assertFalse(corpus.label(scope(), "a", BASE, 1)["windows"]["120"]["participates"])
        source.append(coverage(102, 70, 60, "gap"))
        corpus = Corpus(source, config())
        self.assertIsNone(corpus.label(scope(), "a", BASE, 1)["windows"]["120"]["participates"])
        label = corpus.label(scope(), "a", BASE + 70 * SECOND, 1)
        self.assertFalse(label["windows"]["30"]["participates"])

    def test_duplicate_messages_and_conflicting_payloads(self):
        first = event(1, 0)
        duplicate = dict(first, recordId="r2", captureSeq=2, receivedAt=at(10))
        corpus = Corpus([first, duplicate, coverage()], config())
        self.assertEqual(len(corpus.messages), 1)
        self.assertEqual(corpus.source_index[1]["duplicateOf"], "r1")
        duplicate["text"] = "conflict"
        with self.assertRaises(ValueError):
            Corpus([first, duplicate], config())

    def test_recall_is_applied_at_receipt_not_retroactively(self):
        recall = event(2, 50)
        recall.update(eventType="recall", platformMessageId="m1")
        corpus = Corpus([event(1, 0), recall, coverage()], config())
        before = corpus.snapshot(scope(), BASE + 49 * SECOND, 1)[0]
        after = corpus.snapshot(scope(), BASE + 50 * SECOND, 2)[0]
        self.assertEqual(before["text"], "fictional")
        self.assertIsNone(after["text"])
        self.assertTrue(after["retracted"])
        self.assertEqual(after["recallSourceId"], "r2")

    def test_cross_scope_and_future_references_remain_unresolved(self):
        targets = [dict(scope=scope(g), userId="a") for g in ("group-a", "group-b")]
        events = [event(1, 0, group="group-b"),
                  event(2, 1, replyTo=dict(scope=scope("group-b"), platformMessageId="m1")),
                  event(3, 2, replyTo=dict(scope=scope(), platformMessageId="m4")),
                  event(4, 3, text="FUTURE_SENTINEL")]
        corpus = Corpus(events, config(targets))
        snapshot = corpus.snapshot(scope(), BASE + 3 * SECOND, 4)
        self.assertTrue(snapshot[0]["unresolvedReply"])
        self.assertTrue(snapshot[1]["unresolvedReply"])
        self.assertIsNone(snapshot[1]["replySourceId"])
        self.assertNotIn("FUTURE_SENTINEL", str(snapshot[:2]))

    def test_invalid_sequences_scopes_and_split_order_rejected(self):
        for events in ([event(2, 0), event(1, 1)], [event(1, 1), event(2, 0)],
                       [event(1, 0, group="unconfigured")]):
            with self.assertRaises(ValueError):
                Corpus(events, config())
        bad = config()
        bad["blocks"][1]["start"] = at(599)
        with self.assertRaises(ValueError):
            Corpus(fixture(), bad)


class SamplesTests(unittest.TestCase):
    def make_samples(self, events=None, cfg=None, memory=None):
        corpus = Corpus(events or fixture(), cfg or config())
        return prepare_samples(corpus, "source", digest(encoded(corpus.config)), memory)

    def test_determinism_windows_blocks_and_default_context(self):
        first = self.make_samples()
        second = self.make_samples()
        self.assertEqual(encoded(first), encoded(second))
        inputs, labels, counts = first
        self.assertGreater(counts["splitBoundaryCutoffsExcluded"], 0)
        self.assertEqual({i["id"] for i in inputs}, {l["id"] for l in labels})
        for item in inputs:
            block = next(b for b in config()["blocks"] if b["id"] == item["blockId"])
            self.assertLess(timestamp(item["cutoff"]) + 120 * SECOND, timestamp(block["end"]))
            self.assertLessEqual(len(item["recentMessages"]), 20)

    def test_future_content_identity_and_recall_never_enter_early_input(self):
        future = event(2, 200, text="FORBIDDEN_FUTURE_BODY", senderName="FORBIDDEN_FUTURE_ALIAS")
        inputs, _, _ = self.make_samples([event(1, 0, "b"), future, coverage()])
        early = [i for i in inputs if timestamp(i["cutoff"]) < BASE + 200 * SECOND]
        self.assertTrue(early)
        self.assertNotIn("FORBIDDEN_FUTURE", str(early))
        self.assertNotIn("participates", str(inputs))
        later = [i for i in inputs if timestamp(i["cutoff"]) >= BASE + 200 * SECOND]
        self.assertIn("FORBIDDEN_FUTURE_ALIAS", str(later))

    def test_target_roles_mentions_reply_and_continuation(self):
        events = [event(1, 0), event(2, 1, "b", mentions=["a"],
                  replyTo=dict(scope=scope(), platformMessageId="m1")), coverage()]
        inputs, _, _ = self.make_samples(events)
        one = next(i for i in inputs if i["cutoffKind"] == "event" and i["sourceWatermark"] == 1)
        two = next(i for i in inputs if i["cutoffKind"] == "event" and i["sourceWatermark"] == 2)
        self.assertEqual(one["opportunityKind"], "continuation")
        self.assertTrue(one["recentMessages"][0]["isTarget"])
        self.assertTrue(two["features"]["directAddress"])
        self.assertTrue(two["recentMessages"][-1]["replyToTarget"])

    def test_memory_receives_only_earlier_history_and_checks_sources(self):
        class RecordingMemory(EmptyMemory):
            def __init__(self):
                self.prefixes = []

            def build(self, scope, watermark, earlier_history):
                self.prefixes.append(copy.deepcopy(earlier_history))
                return super().build(scope, watermark, earlier_history)

        memory = RecordingMemory()
        cfg = config()
        cfg["recentMessages"] = 1
        inputs, _, _ = self.make_samples(memory=memory, cfg=cfg)
        for item, prefix in zip(inputs, memory.prefixes):
            self.assertTrue(all(m["captureSeq"] <= item["sourceWatermark"] for m in prefix))
            self.assertFalse({m["recordId"] for m in prefix} & {m["recordId"] for m in item["recentMessages"]})

        class BadMemory(EmptyMemory):
            def recall(self, checkpoint, target_user):
                return [dict(sourceIds=["future-source"], text="leak")]

        with self.assertRaises(ValueError):
            self.make_samples(memory=BadMemory())

    def test_prediction_contract_rejects_invalid_probabilities(self):
        for prediction in ({"30": 0.8, "120": 0.2}, {"30": float("nan"), "120": 1},
                           {"30": True, "120": 1}, {"30": 0.2}, {"30": -1, "120": 1}):
            with self.assertRaises(ValueError):
                validate_prediction(prediction)
        self.assertEqual(validate_prediction({"30": 0.2, "120": 0.8}), {"30": 0.2, "120": 0.8})


if __name__ == "__main__":
    unittest.main()
