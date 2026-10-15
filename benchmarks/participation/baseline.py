"""功能概述：实现仅依赖历史统计的参与概率基线及按目标、群、窗口的离线评分。

主要职责：HistoricalPolicy.fit 只读取 history 段完整双窗口标签；predict 仅接收
冻结输入，以直接寻址、发言间隔和群活跃度分组，样本不足回退到目标同群统计。
choose_threshold 在 dev 上最大化 F1，同分选择较高阈值；metrics 实现按相同概率
整体处理 ties 的 average precision、Brier 和混淆计数。evaluate 固定训练统计与
dev 阈值后运行 test，预测异常保留为失败；未知标签不冒充负例。
代码库关系：依赖 core.py 的概率及范围契约，由 bench.py 调用。独立预测函数
可替换，但没有生产 Planner 或外部模型适配器，也不读取环境变量和网络。
输入输出与副作用：内存输入和报告；预测计时单独返回，不进入确定性内容哈希。
不以成功子集冒充全量指标，失败存在时全量指标为 null，另列成功子集。
"""
from __future__ import annotations

import copy
import time
from collections import defaultdict
from typing import Callable

from core import WINDOWS, scope_key, validate_prediction


def population(item: dict) -> tuple:
    return (*scope_key(item["scope"]), item["targetUser"])


def group_key(item: dict) -> tuple:
    feat = item["features"]
    return (*population(item), feat["directAddress"], feat["recencyBin"], feat["activityBin"])


class HistoricalPolicy:
    def __init__(self, minimum_group_samples: int = 5):
        self.minimum = minimum_group_samples
        self.groups: dict[tuple, list[int]] = {}
        self.totals: dict[tuple, list[int]] = {}

    def fit(self, inputs: list[dict], labels: dict[str, dict]) -> None:
        self.groups.clear()
        self.totals.clear()
        for item in inputs:
            if item["split"] != "history":
                continue
            windows = labels[item["id"]]["windows"]
            if not all(windows[str(w)]["coverageComplete"] and
                       type(windows[str(w)]["participates"]) is bool for w in WINDOWS):
                continue
            delta = [1, int(windows["30"]["participates"]), int(windows["120"]["participates"])]
            for table, key in ((self.groups, group_key(item)), (self.totals, population(item))):
                counts = table.setdefault(key, [0, 0, 0])
                for index, value in enumerate(delta):
                    counts[index] += value

    def stats(self, item: dict) -> tuple[list[int], str]:
        counts = self.groups.get(group_key(item), [0, 0, 0])
        if counts[0] >= self.minimum:
            return counts, "feature_group"
        counts = self.totals.get(population(item), [0, 0, 0])
        return counts, "target_scope" if counts[0] else "untrained_prior"

    def predict(self, frozen_input: dict) -> dict[str, float]:
        counts, _ = self.stats(frozen_input)
        return {str(w): (counts[index + 1] + 1) / (counts[0] + 2) for index, w in enumerate(WINDOWS)}

    def export(self) -> dict:
        return {"policy": "historical-strata/v1", "minimumGroupSamples": self.minimum,
                "smoothing": "Beta(1,1)", "fitSplit": "history",
                "groupSamples": [{"key": list(k), "counts": v} for k, v in sorted(self.groups.items())],
                "targetScopeSamples": [{"key": list(k), "counts": v} for k, v in sorted(self.totals.items())]}


def metrics(pairs: list[tuple[bool, float]], threshold: float) -> dict:
    count = len(pairs)
    positive = sum(y for y, _ in pairs)
    negative = count - positive
    tp = sum(y and p >= threshold for y, p in pairs)
    fp = sum(not y and p >= threshold for y, p in pairs)
    fn = positive - tp
    tn = negative - fp
    result = {"samples": count, "positives": positive,
              "positiveRate": positive / count if count else None,
              "tp": tp, "fp": fp, "fn": fn, "tn": tn, "threshold": threshold}
    if not positive or not negative:
        result.update(averagePrecision=None, precision=None, recall=None, f1=None, brierScore=None,
                      metricReason="empty_population" if not count else "single_class")
        return result
    # 相同概率整体进入阈值，避免样本顺序改变 AP。
    levels: dict[float, list[bool]] = defaultdict(list)
    for y, p in pairs:
        levels[p].append(y)
    ap, found, visited = 0.0, 0, 0
    for probability in sorted(levels, reverse=True):
        ys = levels[probability]
        added = sum(ys)
        found += added
        visited += len(ys)
        ap += (added / positive) * (found / visited)
    result.update(averagePrecision=ap, precision=tp / (tp + fp) if tp + fp else None,
                  recall=tp / positive, f1=2 * tp / (2 * tp + fp + fn),
                  brierScore=sum((p - int(y)) ** 2 for y, p in pairs) / count,
                  metricReason="no_predicted_positives" if tp + fp == 0 else None)
    return result


def choose_threshold(pairs: list[tuple[bool, float]]) -> tuple[float, str]:
    if not pairs or len({y for y, _ in pairs}) != 2:
        return 0.5, "default_insufficient_dev_classes"
    candidates = {0.0, 0.5, 1.0, *(p for _, p in pairs)}
    best = max(candidates, key=lambda t: (metrics(pairs, t)["f1"], t))
    return best, "dev_max_f1_highest_threshold_tie_break"


def summarize(rows: list[dict], labels: dict[str, dict], horizon: str, threshold: float) -> dict:
    known = [r for r in rows if labels[r["id"]]["windows"][horizon]["participates"] is not None]
    successful = [r for r in known if r["status"] == "success"]
    pairs = [(labels[r["id"]]["windows"][horizon]["participates"], r["probabilities"][horizon]) for r in successful]
    failures = len(known) - len(successful)
    values = metrics(pairs, threshold)
    result = {"attempted": len(rows), "successes": sum(r["status"] == "success" for r in rows),
              "failures": sum(r["status"] == "failed" for r in rows), "knownLabels": len(known),
              "knownLabelFailures": failures, "unknownLabels": len(rows) - len(known),
              "incompleteCoverage": sum(not labels[r["id"]]["windows"][horizon]["coverageComplete"] for r in rows),
              "positiveRate": sum(labels[r["id"]]["windows"][horizon]["participates"] is True for r in known) / len(known) if known else None,
              "delayObserved": sum(labels[r["id"]]["delayStatus"] == "observed" for r in rows),
              "delayCensored": sum(labels[r["id"]]["delayStatus"] == "censored" for r in rows),
              "completedOnly": values, "metrics": copy.deepcopy(values)}
    if failures:
        for field in ("averagePrecision", "precision", "recall", "f1", "brierScore"):
            result["metrics"][field] = None
        result["metrics"].update(samples=len(known), metricReason="prediction_failures")
        # 成功子集的混淆矩阵不可作为包含失败的全量矩阵。
        for field in ("tp", "fp", "fn", "tn"):
            result["metrics"][field] = None
    return result


def evaluate(inputs: list[dict], label_rows: list[dict], minimum: int = 5,
             predict: Callable[[dict], dict] | None = None) -> tuple[dict, list[dict], dict]:
    labels = {row["id"]: row for row in label_rows}
    if len(labels) != len(label_rows) or len({i["id"] for i in inputs}) != len(inputs) or set(labels) != {i["id"] for i in inputs}:
        raise ValueError("input and label IDs must be unique and match exactly")
    policy = HistoricalPolicy(minimum)
    policy.fit(inputs, labels)
    predictor = predict if predict is not None else policy.predict
    rows, timings = [], []
    # 所有预测只拿副本，候选既拿不到标签，也不能更改随后评分使用的输入。
    for item in inputs:
        start = time.perf_counter()
        row = {k: item[k] for k in ("id", "split", "scope", "targetUser", "blockId")}
        row.update(sourceWatermark=item["sourceWatermark"], features=item["features"],
                   evidenceSourceIds=[m["recordId"] for m in item["recentMessages"]],
                   memoryEvidence=item["memoryEvidence"])
        if predict is None:
            counts, fallback = policy.stats(item)
            row.update(trainingSamples=counts[0], probabilitySource=fallback)
        try:
            row.update(status="success", probabilities=validate_prediction(predictor(copy.deepcopy(item))))
        except Exception as error:
            row.update(status="failed", probabilities=None, errorType=type(error).__name__)
        timings.append({"id": item["id"], "predictionSeconds": time.perf_counter() - start})
        rows.append(row)
    populations = sorted({population(i) for i in inputs})
    thresholds, summaries = [], []
    for key in populations:
        selected = [r for r in rows if population(r) == key]
        for horizon in map(str, WINDOWS):
            dev = [(labels[r["id"]]["windows"][horizon]["participates"], r["probabilities"][horizon])
                   for r in selected if r["split"] == "dev" and r["status"] == "success"
                   and labels[r["id"]]["windows"][horizon]["participates"] is not None]
            threshold, reason = choose_threshold(dev)
            identity = {"scope": selected[0]["scope"], "targetUser": key[-1], "windowSeconds": int(horizon)}
            thresholds.append({**identity, "threshold": threshold, "reason": reason, "devSamples": len(dev)})
            for split in ("history", "dev", "test"):
                split_rows = [r for r in selected if r["split"] == split]
                role = {"history": "in_sample_diagnostic", "dev": "threshold_selection", "test": "held_out"}[split]
                summaries.append({**identity, "split": split, "evaluationRole": role,
                                  **summarize(split_rows, labels, horizon, threshold),
                                  "blocks": sorted({r["blockId"] for r in split_rows})})
    return {"policy": policy.export(), "thresholds": thresholds, "groups": summaries,
            "sampleDependence": "overlapping cutoffs share blockId; no independent-sample inference",
            "delayPrediction": {"available": False, "timeError": None, "observationWindowSeconds": 120}}, rows, {"timings": timings}
