"""功能概述：将版本化群聊 journal 冻结为历史输入、自动参与标签及来源索引。

主要职责：load_corpus 校验事件、配置、覆盖和去重；Corpus.visible/snapshot 恢复
截点的同群消息与撤回；continuous_end/label 处理覆盖缺口、窗口和等待时间；
prepare_samples 先按连续时间块限制窗口，再生成事件及定时截点。
MemoryAdapter/EmptyMemory 定义仅接收旧历史、群范围和来源水位的离线记忆边界；
validate_prediction 校验 ParticipantPolicy 的双窗口概率。features 只从历史前缀
提取目标参与、群活跃度和直接寻址信息。所有时间采用 UTC 整数微秒。
代码库关系：bench.py 调用本模块；baseline.py 仅消费已冻结输入；不接入生产
Runtime、数据库、NapCat 或模型。输入和标签分开返回，未来覆盖仅供评分使用。
输入输出与副作用：只读 JSONL/JSON 文件，其他函数在内存计算；无网络、凭据或
持久化副作用。格式冲突、乱序、跨块配置及重复消息内容冲突直接报错。
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

PROTOCOL = "kaguya-participation/v1"
WINDOWS = (30, 120)
SECOND = 1_000_000
SCOPE_FIELDS = ("platform", "adapterId", "accountId", "groupId")


def encoded(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                       allow_nan=False) + "\n").encode("utf-8")


def digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def timestamp(value: str) -> int:
    date = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if date.utcoffset() is None:
        raise ValueError("timestamps require an explicit timezone")
    delta = date.astimezone(timezone.utc) - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * SECOND + delta.microseconds


def iso(value: int) -> str:
    from datetime import timedelta
    return (datetime(1970, 1, 1, tzinfo=timezone.utc) + timedelta(microseconds=value)).isoformat()


def nonempty(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("expected a nonblank string")
    return value


def integer(value: object, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError("expected an integer within range")
    return value


def scope_key(scope: dict) -> tuple:
    if not isinstance(scope, dict) or set(scope) != set(SCOPE_FIELDS):
        raise ValueError("scope must identify platform, adapter, login account and group")
    return tuple(nonempty(scope[field]) for field in SCOPE_FIELDS)


class MemoryAdapter(Protocol):
    def build(self, scope: dict, watermark: int, earlier_history: list[dict]) -> dict: ...
    def recall(self, checkpoint: dict, target_user: str) -> list[dict]: ...


class EmptyMemory:
    def build(self, scope: dict, watermark: int, earlier_history: list[dict]) -> dict:
        return {"adapter": "empty/v1", "scope": copy.deepcopy(scope), "sourceWatermark": watermark,
                "prefixSha256": digest(encoded(earlier_history))}

    def recall(self, checkpoint: dict, target_user: str) -> list[dict]:
        return []


class ParticipantPolicy(Protocol):
    def predict(self, frozen_input: dict) -> dict[str, float]: ...


def validate_prediction(prediction: dict) -> dict:
    if not isinstance(prediction, dict) or set(prediction) != {"30", "120"}:
        raise ValueError("policy must return probabilities for exactly 30 and 120 seconds")
    for value in prediction.values():
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
            raise ValueError("participation probability must be finite and within [0, 1]")
    if prediction["30"] > prediction["120"]:
        raise ValueError("long-window probability must be at least short-window probability")
    return prediction


def validate_config(config: dict) -> dict:
    if type(config["schemaVersion"]) is not int or config["schemaVersion"] != 1 or config["dataKind"] not in ("synthetic", "private"):
        raise ValueError("unsupported config version or data kind")
    targets = [(scope_key(t["scope"]), nonempty(t["userId"])) for t in config["targets"]]
    if not targets or len(targets) != len(set(targets)):
        raise ValueError("targets must be nonempty and unique")
    blocks = config["blocks"]
    if not blocks or len({nonempty(b["id"]) for b in blocks}) != len(blocks):
        raise ValueError("blocks must be nonempty with unique IDs")
    previous_end = None
    split_rank = -1
    for block in blocks:
        start, end = timestamp(block["start"]), timestamp(block["end"])
        if start >= end or (previous_end is not None and start < previous_end):
            raise ValueError("blocks must be ordered, disjoint, positive time intervals")
        if block["split"] not in ("history", "dev", "test"):
            raise ValueError("invalid split")
        rank = ("history", "dev", "test").index(block["split"])
        if rank < split_rank:
            raise ValueError("history, dev and test must be chronological")
        previous_end, split_rank = end, rank
    if {b["split"] for b in blocks} != {"history", "dev", "test"}:
        raise ValueError("history, dev and test blocks are required")
    result = copy.deepcopy(config)
    result.setdefault("recentMessages", 20)
    result.setdefault("minGroupSamples", 5)
    integer(result["recentMessages"], 1)
    integer(result["minGroupSamples"], 1)
    return result


class Corpus:
    def __init__(self, events: list[dict], config: dict):
        self.config = validate_config(config)
        self.events: list[dict] = []
        self.messages: list[dict] = []
        self.recalls: list[dict] = []
        self.coverage: dict[tuple, list[dict]] = {}
        self.source_index: list[dict] = []
        seen_records: set[str] = set()
        seen_messages: dict[tuple, dict] = {}
        last_seq, last_time = -1, None
        allowed = {scope_key(t["scope"]) for t in self.config["targets"]}
        for source in events:
            event = copy.deepcopy(source)
            if type(event["schemaVersion"]) is not int or event["schemaVersion"] != 1:
                raise ValueError("unsupported event version")
            record_id = nonempty(event["recordId"])
            seq = integer(event["captureSeq"], 1)
            received = timestamp(event["receivedAt"])
            timestamp(event["occurredAt"])
            if record_id in seen_records or seq <= last_seq or (last_time is not None and received < last_time):
                raise ValueError("record IDs must be unique; receipt sequence and time must be ordered")
            seen_records.add(record_id)
            last_seq, last_time = seq, received
            key = scope_key(event["scope"])
            if key not in allowed:
                raise ValueError("source contains a scope outside configured targets")
            event["_time"] = received
            kind = event["eventType"]
            duplicate = None
            if kind == "message":
                nonempty(event["senderId"])
                nonempty(event["platformMessageId"])
                if not isinstance(event["text"], str):
                    raise ValueError("message text must be a string")
                for field in ("mentions", "mediaTypes"):
                    event.setdefault(field, [])
                    if not isinstance(event[field], list):
                        raise ValueError("mentions and mediaTypes must be arrays")
                    for value in event[field]:
                        nonempty(value)
                event.setdefault("replyTo", None)
                event.setdefault("senderName", None)
                if event["senderName"] is not None:
                    nonempty(event["senderName"])
                if event["replyTo"] is not None:
                    nonempty(event["replyTo"]["platformMessageId"])
                    scope_key(event["replyTo"]["scope"])
                message_key = (key, event["platformMessageId"])
                if message_key in seen_messages:
                    original = seen_messages[message_key]
                    fields = ("senderId", "text", "mentions", "replyTo", "mediaTypes", "senderName", "occurredAt")
                    if any(original[f] != event[f] for f in fields):
                        raise ValueError("duplicate platform message has conflicting content")
                    duplicate = original["recordId"]
                else:
                    seen_messages[message_key] = event
                    self.messages.append(event)
            elif kind == "recall":
                nonempty(event["platformMessageId"])
                self.recalls.append(event)
            elif kind == "coverage":
                start, end = timestamp(event["start"]), timestamp(event["end"])
                if start >= end or end > received or event["status"] not in ("complete", "gap"):
                    raise ValueError("invalid coverage interval")
                self.coverage.setdefault(key, []).append({"start": start, "end": end, "status": event["status"]})
            else:
                raise ValueError("unknown events require capture normalization before export")
            self.events.append(event)
            self.source_index.append({"recordId": record_id, "captureSeq": seq,
                                      "scope": event["scope"], "eventType": kind,
                                      "receivedAt": event["receivedAt"], "duplicateOf": duplicate,
                                      "recordSha256": digest(encoded(source))})
        if not self.messages:
            raise ValueError("corpus must contain messages")

    def visible(self, scope: dict, cutoff: int, watermark: int) -> list[dict]:
        key = scope_key(scope)
        return [e for e in self.messages if scope_key(e["scope"]) == key
                and e["captureSeq"] <= watermark and e["_time"] <= cutoff]

    def snapshot(self, scope: dict, cutoff: int, watermark: int) -> list[dict]:
        key = scope_key(scope)
        visible = self.visible(scope, cutoff, watermark)
        # 只解析消息收到当时已经存在的引用；未知引用不由后来的记录补全。
        by_id: dict[str, dict] = {}
        result = []
        for event in visible:
            reply = event["replyTo"]
            referenced = (by_id.get(reply["platformMessageId"])
                          if reply and scope_key(reply["scope"]) == key else None)
            item = {"recordId": event["recordId"], "captureSeq": event["captureSeq"],
                    "platformMessageId": event["platformMessageId"], "senderId": event["senderId"],
                    "senderName": event["senderName"], "receivedAt": event["receivedAt"],
                    "occurredAt": event["occurredAt"], "text": event["text"],
                    "mentions": list(event["mentions"]), "mediaTypes": list(event["mediaTypes"]),
                    "isOwnMessage": event["senderId"] == scope["accountId"],
                    "replySourceId": referenced["recordId"] if referenced else None,
                    "replySenderId": referenced["senderId"] if referenced else None,
                    "unresolvedReply": bool(reply and not referenced), "retracted": False}
            result.append(item)
            by_id[event["platformMessageId"]] = item
        for recall in self.recalls:
            if scope_key(recall["scope"]) != key or recall["captureSeq"] > watermark or recall["_time"] > cutoff:
                continue
            original = by_id.get(recall["platformMessageId"])
            if original and original["captureSeq"] < recall["captureSeq"]:
                original.update(text=None, mediaTypes=[], retracted=True, recallSourceId=recall["recordId"])
        return result

    def continuous_end(self, scope: dict, start: int, end: int) -> int:
        intervals = self.coverage.get(scope_key(scope), [])
        cursor = start
        for part in sorted((i for i in intervals if i["status"] == "complete"), key=lambda i: i["start"]):
            if part["start"] > cursor:
                break
            if part["end"] > cursor:
                cursor = min(part["end"], end)
        for gap in intervals:
            if gap["status"] == "gap" and gap["end"] > start and gap["start"] <= cursor:
                cursor = min(cursor, max(start, gap["start"] - 1))
        return min(cursor, end)

    def covered_point(self, scope: dict, point: int) -> bool:
        intervals = self.coverage.get(scope_key(scope), [])
        return (any(i["status"] == "complete" and i["start"] <= point <= i["end"] for i in intervals)
                and not any(i["status"] == "gap" and i["start"] <= point < i["end"] for i in intervals))

    def label(self, scope: dict, target: str, cutoff: int, watermark: int) -> dict:
        future = [e for e in self.messages if scope_key(e["scope"]) == scope_key(scope)
                  and (e["_time"] > cutoff or (e["_time"] == cutoff and e["captureSeq"] > watermark))
                  and e["_time"] <= cutoff + max(WINDOWS) * SECOND]
        first = next((e for e in future if e["senderId"] == target), None)
        windows = {}
        for horizon in WINDOWS:
            end = cutoff + horizon * SECOND
            covered = self.continuous_end(scope, cutoff, end)
            positive = first is not None and first["_time"] <= end
            windows[str(horizon)] = {
                "participates": True if positive else (False if covered == end else None),
                "coverageComplete": covered == end,
                "status": "positive" if positive else ("negative" if covered == end else "unknown"),
                "observedUntil": iso(covered),
                "firstObservedMessageId": first["recordId"] if positive else None,
            }
        first_complete = (first is not None and self.covered_point(scope, cutoff)
                          and self.continuous_end(scope, cutoff, first["_time"]) == first["_time"])
        return {"windows": windows, "firstMessageDelaySeconds": (first["_time"] - cutoff) / SECOND if first_complete else None,
                "interveningMessages": sum(e["senderId"] != target for e in future
                                           if first and e["captureSeq"] < first["captureSeq"]) if first_complete else None,
                "delayObservationUpperBoundSeconds": (self.continuous_end(scope, cutoff, cutoff + 120 * SECOND) - cutoff) / SECOND,
                "delayStatus": "observed" if first_complete else "censored"}


def features(messages: list[dict], target: str, cutoff: int) -> dict:
    own = [m for m in messages if m["senderId"] == target]
    delay = (cutoff - timestamp(own[-1]["receivedAt"])) / SECOND if own else None
    recency = "never" if delay is None else ("lt30" if delay < 30 else ("30to120" if delay <= 120 else "gt120"))
    active = [m for m in messages if cutoff - timestamp(m["receivedAt"]) <= 120 * SECOND]
    direct = any(target in m["mentions"] or m["replySenderId"] == target for m in active
                 if m["senderId"] != target and cutoff - timestamp(m["receivedAt"]) <= 30 * SECOND)
    return {"directAddress": direct, "recencyBin": recency,
            "lastTargetDelaySeconds": delay, "activityBin": "lt5" if len(active) < 5 else "gte5",
            "groupMessagesLast120Seconds": len(active)}


def prepare_samples(corpus: Corpus, source_hash: str, config_hash: str,
                    memory: MemoryAdapter | None = None) -> tuple[list, list, dict]:
    adapter = memory if memory is not None else EmptyMemory()
    inputs, labels = [], []
    skipped = 0
    for block in corpus.config["blocks"]:
        start, end = timestamp(block["start"]), timestamp(block["end"])
        for target in corpus.config["targets"]:
            scope, user = target["scope"], target["userId"]
            cuts = [(e["_time"], e["captureSeq"], "event") for e in corpus.messages
                    if scope_key(e["scope"]) == scope_key(scope) and start <= e["_time"] < end]
            for tick in range(start, end, 30 * SECOND):
                watermark = max((e["captureSeq"] for e in corpus.events if e["_time"] <= tick), default=0)
                cuts.append((tick, watermark, "time"))
            for cutoff, watermark, kind in sorted(cuts):
                # split 为半开区间；最大窗口末端也必须属于当前 split。
                if cutoff + max(WINDOWS) * SECOND >= end:
                    skipped += 1
                    continue
                provenance = {"protocol": PROTOCOL, "sourceSha256": source_hash, "configSha256": config_hash,
                              "scope": scope, "targetUser": user, "blockId": block["id"],
                              "cutoff": iso(cutoff), "sourceWatermark": watermark, "cutoffKind": kind}
                sample_id = digest(encoded(provenance))
                snapshot = corpus.snapshot(scope, cutoff, watermark)
                size = corpus.config["recentMessages"]
                earlier, recent = snapshot[:-size], snapshot[-size:]
                checkpoint = adapter.build(copy.deepcopy(scope), watermark, copy.deepcopy(earlier))
                if checkpoint.get("scope") != scope or checkpoint.get("sourceWatermark") != watermark:
                    raise ValueError("memory checkpoint scope or source watermark mismatch")
                evidence = adapter.recall(copy.deepcopy(checkpoint), user)
                eligible = {m["recordId"] for m in earlier}
                if not isinstance(evidence, list) or any(
                    not isinstance(e, dict) or not isinstance(e.get("sourceIds"), list) or not e["sourceIds"] or
                    any(not isinstance(s, str) for s in e["sourceIds"]) or
                    not set(e["sourceIds"]).issubset(eligible) for e in evidence
                ):
                    raise ValueError("memory evidence must cite earlier same-scope prefix records")
                for message in recent:
                    message["isTarget"] = message["senderId"] == user
                    message["mentionsTarget"] = user in message["mentions"]
                    message["replyToTarget"] = message["replySenderId"] == user
                inputs.append({"id": sample_id, "protocol": PROTOCOL, "dataKind": corpus.config["dataKind"],
                               "split": block["split"], **{k: provenance[k] for k in (
                                   "scope", "targetUser", "blockId", "cutoff", "sourceWatermark", "cutoffKind")},
                               "opportunityKind": "continuation" if snapshot and snapshot[-1]["senderId"] == user else "joining",
                               "recentMessages": recent, "features": features(snapshot, user, cutoff),
                               "memoryCheckpoint": checkpoint, "memoryEvidence": evidence})
                labels.append({"id": sample_id, **corpus.label(scope, user, cutoff, watermark)})
    if not inputs:
        raise ValueError("no eligible cutoffs; blocks must leave room for the 120-second window")
    return inputs, labels, {"samples": len(inputs), "splitBoundaryCutoffsExcluded": skipped,
                            "duplicateMessages": sum(i["duplicateOf"] is not None for i in corpus.source_index)}


def load_corpus(source: Path, config_path: Path) -> tuple[Corpus, str, str]:
    raw = source.read_bytes()
    config = validate_config(json.loads(config_path.read_text(encoding="utf-8")))
    events = [json.loads(line) for line in raw.splitlines() if line.strip()]
    return Corpus(events, config), digest(raw), digest(encoded(config))
