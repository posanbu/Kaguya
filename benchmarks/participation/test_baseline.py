"""功能概述：以手算概率和指标验证历史统计、dev 阈值及失败分母。

主要职责：item/label 构造最小虚构冻结输入和独立标签；BaselineTests 验证
Beta(1,1) 平滑、稀疏回退、history-only 拟合、未知窗口排除和概率单调；
MetricTests 验证 AP ties、Brier、F1 阈值、单类别 null 与候选异常保留。
代码库关系：调用 baseline.py 和 core.py；候选输入隔离测试修改候选副本，
确认评分所用原始输入及标签不受影响。无外部服务、异步等待和持久化状态。
"""
import copy
import unittest

from baseline import HistoricalPolicy, choose_threshold, evaluate, metrics, summarize
from test_core import scope


def item(sample_id, split="history", direct=False, group="group-a"):
    return dict(id=sample_id, split=split, scope=scope(group), targetUser="a", blockId=f"block-{split}",
                sourceWatermark=10, features=dict(directAddress=direct, recencyBin="lt30", activityBin="lt5"),
                recentMessages=[dict(recordId="historical-evidence")], memoryEvidence=[])


def label(sample_id, short, long, complete=True):
    return dict(id=sample_id, windows={str(w): dict(participates=y, coverageComplete=complete)
                                     for w, y in ((30, short), (120, long))},
                delayStatus="censored")


class BaselineTests(unittest.TestCase):
    def test_hand_calculated_smoothing_group_and_scope_fallback(self):
        inputs = [item(str(i), direct=i < 2) for i in range(4)]
        labels = {str(i): label(str(i), i == 0, i < 3) for i in range(4)}
        policy = HistoricalPolicy(3)
        policy.fit(inputs, labels)
        self.assertEqual(policy.predict(item("new", direct=True)), {"30": 2 / 6, "120": 4 / 6})
        self.assertEqual(policy.stats(item("new"))[1], "target_scope")
        policy.minimum = 2
        self.assertEqual(policy.predict(item("new", direct=True)), {"30": 2 / 4, "120": 3 / 4})
        self.assertEqual(policy.stats(item("new", direct=True))[1], "feature_group")
        self.assertEqual(policy.predict(item("new", group="different")), {"30": 0.5, "120": 0.5})
        self.assertEqual(policy.stats(item("new", group="different"))[1], "untrained_prior")

    def test_fit_excludes_dev_test_unknown_and_incomplete_positive(self):
        inputs = [item("h"), item("d", "dev"), item("t", "test"), item("gap"), item("unknown")]
        rows = [label("h", False, True), label("d", True, True), label("t", True, True),
                label("gap", True, True, False), label("unknown", None, None)]
        policy = HistoricalPolicy()
        policy.fit(inputs, {r["id"]: r for r in rows})
        self.assertEqual(policy.stats(inputs[0])[0], [1, 0, 1])
        self.assertEqual(policy.predict(inputs[0]), {"30": 1 / 3, "120": 2 / 3})

    def test_test_labels_cannot_change_fit_threshold_or_predictions(self):
        inputs = [item("h0"), item("h1"), item("d0", "dev"), item("d1", "dev"), item("t", "test")]
        labels = [label("h0", False, False), label("h1", True, True),
                  label("d0", False, False), label("d1", True, True), label("t", True, True)]
        before, predictions, _ = evaluate(inputs, labels)
        labels[-1] = label("t", False, False)
        after, second, _ = evaluate(inputs, labels)
        self.assertEqual(before["policy"], after["policy"])
        self.assertEqual(before["thresholds"], after["thresholds"])
        self.assertEqual(predictions, second)

    def test_predictions_receive_only_inputs_and_cannot_mutate_scoring_state(self):
        inputs = [item("h"), item("d", "dev"), item("t", "test")]
        frozen = copy.deepcopy(inputs)
        labels = [label(i["id"], False, True) for i in inputs]

        def candidate(request):
            self.assertNotIn("windows", request)
            self.assertNotIn("participates", str(request))
            request["features"].clear()
            return {"30": 0.2, "120": 0.8}

        summary, rows, _ = evaluate(inputs, labels, predict=candidate)
        self.assertEqual(inputs, frozen)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(r["status"] == "success" for r in rows))
        self.assertEqual(summary["delayPrediction"]["timeError"], None)

    def test_duplicate_input_ids_are_rejected_before_prediction(self):
        with self.assertRaisesRegex(ValueError, "unique"):
            evaluate([item("same"), item("same")], [label("same", False, True)])


class MetricTests(unittest.TestCase):
    def test_hand_calculated_ap_ties_brier_and_confusion_matrix(self):
        pairs = [(True, 0.9), (False, 0.8), (True, 0.8), (False, 0.1)]
        result = metrics(pairs, 0.8)
        self.assertAlmostEqual(result["averagePrecision"], 5 / 6)
        self.assertAlmostEqual(result["brierScore"], 0.175)
        self.assertAlmostEqual(result["precision"], 2 / 3)
        self.assertEqual(result["recall"], 1)
        self.assertEqual(result["f1"], 0.8)
        self.assertEqual([result[k] for k in ("tp", "fp", "fn", "tn")], [2, 1, 0, 1])
        self.assertEqual(metrics(list(reversed(pairs)), 0.8), result)

    def test_threshold_tie_break_and_no_label_defaults(self):
        threshold, reason = choose_threshold([(True, 0.8), (False, 0.8), (True, 0.4), (False, 0.4)])
        self.assertEqual(threshold, 0.4)
        self.assertIn("dev_max_f1", reason)
        self.assertEqual(choose_threshold([])[0], 0.5)
        self.assertEqual(choose_threshold([(False, 0.9)])[0], 0.5)

    def test_single_class_empty_population_and_zero_prediction_denominator(self):
        for pairs in ([], [(False, 0.1)], [(True, 0.9)]):
            result = metrics(pairs, 0.5)
            for field in ("averagePrecision", "precision", "recall", "f1", "brierScore"):
                self.assertIsNone(result[field])
            self.assertIsNotNone(result["metricReason"])
        result = metrics([(True, 0.1), (False, 0.2)], 0.5)
        self.assertIsNone(result["precision"])
        self.assertEqual(result["recall"], 0)
        self.assertEqual(result["f1"], 0)

    def test_failures_unknown_labels_and_positive_rate_keep_denominators(self):
        inputs = [item("ok", "test"), item("bad", "test"), item("unknown", "test")]
        labels = [label("ok", False, False), label("bad", True, True), label("unknown", None, None, False)]

        def candidate(request):
            if request["id"] == "bad":
                raise TimeoutError("test-only failure")
            return {"30": 0.2, "120": 0.8}

        summary, rows, _ = evaluate(inputs, labels, predict=candidate)
        group = next(g for g in summary["groups"] if g["split"] == "test" and g["windowSeconds"] == 30)
        self.assertEqual(group["attempted"], 3)
        self.assertEqual(group["failures"], 1)
        self.assertEqual(group["knownLabels"], 2)
        self.assertEqual(group["unknownLabels"], 1)
        self.assertEqual(group["positiveRate"], 0.5)
        self.assertIsNone(group["metrics"]["f1"])
        self.assertEqual(group["metrics"]["metricReason"], "prediction_failures")
        self.assertEqual(group["metrics"]["samples"], 2)
        self.assertEqual(group["completedOnly"]["samples"], 1)
        self.assertEqual(next(r for r in rows if r["id"] == "bad")["errorType"], "TimeoutError")


if __name__ == "__main__":
    unittest.main()
