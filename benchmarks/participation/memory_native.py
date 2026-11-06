"""功能概述：把参与评测的 MemoryAdapter 接到本地 native Memory 批处理结果。

主要职责：NativeRequests 收集按范围、水位、旧历史哈希及目标绑定的请求；
NativeSnapshots 只接受对应请求的完整响应，拒绝缺失、重复、跨目标或跨前缀结果。
证据字段限定为 native bridge 的协议字段；附带来源元数据必须逐项匹配旧历史，
不能借合法 sourceIds 混入未来来源、标签或人物信息。
make_request 定义 Python/TypeScript 共用的排序 JSON 哈希，checkpoint 不携带标签。
代码库关系：bench.py 导出请求并导入 native-memory.ts 的结果；core.prepare_samples
仍负责最终来源边界检查。此模块不启动子进程、不连接数据库或模型。
输入输出与副作用：只读取显式指定的本地响应文件，内存缓存只包含当前旧历史；
返回深拷贝以隔离候选修改。缺失结果报错，不静默回退到 EmptyMemory。
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from core import digest, encoded, integer, nonempty, scope_key

ADAPTER = "native-extractive/v1"


def make_request(checkpoint: dict, history: list[dict], target: str) -> dict:
    body = {**checkpoint, "earlierHistory": copy.deepcopy(history), "targetUser": nonempty(target)}
    return {"requestId": digest(encoded(body)), **body}


class NativeRequests:
    def __init__(self):
        self.requests: dict[str, dict] = {}
        self._checkpoint: dict | None = None
        self._history: list[dict] = []

    def build(self, scope: dict, watermark: int, earlier_history: list[dict]) -> dict:
        scope_key(scope)
        integer(watermark)
        self._history = copy.deepcopy(earlier_history)
        self._checkpoint = {"adapter": ADAPTER, "scope": copy.deepcopy(scope),
                            "sourceWatermark": watermark, "prefixSha256": digest(encoded(earlier_history))}
        return copy.deepcopy(self._checkpoint)

    def _request(self, checkpoint: dict, target_user: str) -> dict:
        if self._checkpoint is None or checkpoint != self._checkpoint:
            raise ValueError("native memory checkpoint does not match the current build")
        return make_request(checkpoint, self._history, target_user)

    def recall(self, checkpoint: dict, target_user: str) -> list[dict]:
        request = self._request(checkpoint, target_user)
        self.requests[request["requestId"]] = request
        return []


class NativeSnapshots(NativeRequests):
    def __init__(self, path: Path):
        super().__init__()
        raw = path.read_bytes()
        self.source_sha256 = digest(raw)
        self.responses: dict[str, dict] = {}
        self.used: set[str] = set()
        for line in raw.splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError("native response must be an object")
            key = nonempty(row.get("requestId"))
            if key in self.responses:
                raise ValueError("duplicate native response requestId")
            self.responses[key] = row

    def recall(self, checkpoint: dict, target_user: str) -> list[dict]:
        request = self._request(checkpoint, target_user)
        response = self.responses.get(request["requestId"])
        if response is None:
            raise ValueError(f"missing native memory response for frozen prefix and target: requestId={request['requestId']}")
        fields = ("requestId", "adapter", "scope", "sourceWatermark", "prefixSha256", "targetUser")
        if type(response.get("sourceWatermark")) is not int or any(response.get(field) != request[field] for field in fields):
            raise ValueError("native memory response binding mismatch")
        metrics = response.get("metrics")
        if not isinstance(metrics, dict) or type(metrics.get("networkRequests")) is not int or metrics["networkRequests"] != 0:
            raise ValueError("native memory response must report zero network requests")
        evidence = response.get("evidence")
        eligible = {m["recordId"] for m in self._history if not m.get("retracted")}
        if not isinstance(evidence, list) or any(
            not isinstance(e, dict) or not isinstance(e.get("text"), str) or
            not isinstance(e.get("sourceIds"), list) or not e["sourceIds"] or
            any(not isinstance(source, str) or source not in eligible for source in e["sourceIds"])
            for e in evidence
        ):
            raise ValueError("native evidence must cite unretracted earlier prefix records")
        by_id = {m["recordId"]: m for m in self._history}
        for item in evidence:
            if not set(item).issubset({"sourceIds", "text", "nodeId", "truncated", "channels", "sources"}):
                raise ValueError("native evidence contains unsupported fields")
            if len(set(item["sourceIds"])) != len(item["sourceIds"]):
                raise ValueError("native evidence sourceIds must be unique")
            if "nodeId" in item:
                nonempty(item["nodeId"])
            if "truncated" in item and type(item["truncated"]) is not bool:
                raise ValueError("native evidence truncated must be boolean")
            if "channels" in item and (not isinstance(item["channels"], list) or
                                       any(not isinstance(channel, str) or not channel.strip() for channel in item["channels"])):
                raise ValueError("native evidence channels must be strings")
            if "sources" in item:
                expected = [{"recordId": source["recordId"], "senderId": source["senderId"],
                             "receivedAt": source["receivedAt"], "occurredAt": source["occurredAt"],
                             "mediaTypes": source["mediaTypes"], "missingMediaContent": bool(source["mediaTypes"]),
                             "replySourceId": source["replySourceId"], "unresolvedReply": source["unresolvedReply"]}
                            for source in (by_id[source_id] for source_id in item["sourceIds"])]
                if encoded(item["sources"]) != encoded(expected):
                    raise ValueError("native evidence source metadata does not match the frozen prefix")
        self.used.add(request["requestId"])
        return copy.deepcopy(evidence)

    def assert_complete(self) -> None:
        if self.used != set(self.responses):
            raise ValueError("native responses include unused requests from a different dataset")
