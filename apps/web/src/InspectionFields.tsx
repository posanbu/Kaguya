/**
 * 功能概述：把已脱敏的领域字段渲染成可读的标签、列表和键值，不以 JSON 作为默认界面。
 * InspectionFields 展示服务端声明的字段；ReadableValue 递归处理习惯/评分组成等结构，
 * 保留未知标识原值，限制初始展开的数组长度。InspectionStatus 给常见结果加中文与文字状态。
 * 联想状态和检索原因使用明确中文标签；未知枚举仍保留原值。
 * 只渲染文本，不执行 HTML，也不解析来自内容的链接；原始 JSON 留给详情折叠区。
 */
import type { JsonValue } from "@kaguya/schema";
import { StatusBadge } from "./components/ui.js";
const words: Record<string, string> = {
  attend: "进入规划",
  defer: "延后观察",
  ignore: "忽略",
  completed: "已完成",
  complete: "已完成",
  failed: "失败",
  empty: "无内容",
  superseded: "已被替代",
  cancelled: "已取消",
  rejected: "未通过验证",
  invalid: "无效",
  missing: "来源缺失",
  message: "发送消息",
  wait: "等待",
  silent: "静默",
  unresolved: "未解析",
  ambiguous: "存在歧义",
  degraded: "降级",
  validated: "已验证",
  matched: "已召回",
  unavailable: "不可用",
  "policy-filtered": "策略过滤",
  "sparse-match": "稀疏检索命中",
  "coverage-ranked": "按覆盖程度排序",
  "no-sparse-match": "没有稀疏匹配",
  "no-candidate": "没有候选",
  "empty-query-policy": "查询为空，跳过检索",
  "provider-unavailable": "检索服务不可用",
  "retrieval-failed": "检索失败",
  "no-candidates": "没有候选",
  "no-match": "没有匹配项",
  "score-below-threshold": "分数未达到阈值",
  "score-threshold-met": "达到分数阈值",
  "wait-budget-exhausted": "等待预算已用尽",
  muted: "已静音",
  "frequency-zero": "频率为零",
  "private-conversation": "私聊输入",
  "topic-expired": "话题已过期",
  "no-response-needed": "无需回复",
  "planner-unavailable": "规划器不可用",
  "avoid-interruption": "避免打断",
  "await-more-context": "等待更多上下文",
  respond: "回应消息",
  contribute: "参与话题",
  canonical: "规范范围",
  ephemeral: "临时范围",
  group: "群聊",
  private: "私聊",
  web: "网页",
};
const labels: Record<string, string> = {
  relevance: "相关性",
  content: "内容",
  pressure: "积压压力",
  recentPresencePenalty: "近期在场惩罚",
  frequencyFactor: "频率因子",
  preFrequencyScore: "频率调整前分数",
  situation: "情境",
  style: "表达方式",
  occurrences: "出现次数",
  reviewStatus: "验证状态",
  sourceInformationIds: "来源信息",
  scopeInformationId: "会话范围",
  habitId: "习惯 ID",
  version: "版本",
  modelId: "模型",
  providerId: "提供方",
  revision: "版本",
  dimensions: "维度",
  kind: "类型",
  groupId: "群号",
  userId: "用户",
  action: "动作",
  reason: "原因",
  waitSeconds: "等待秒数",
  target: "目标",
  platform: "平台",
  adapterId: "适配器",
  destination: "会话",
  text: "正文",
  inputTokens: "输入 Token",
  outputTokens: "输出 Token",
  totalTokens: "总 Token",
  informationId: "信息 ID",
  occurredAt: "发生时间",
};
export function statusLabel(value: string) {
  return words[value] ?? value;
}
export function InspectionStatus({ value }: { value: string }) {
  const tone = ["failed", "invalid", "rejected"].includes(value)
    ? "error"
    : ["completed", "complete", "attend", "validated"].includes(value)
      ? "success"
      : ["defer", "wait", "degraded", "ambiguous"].includes(value)
        ? "warning"
        : "neutral";
  return <StatusBadge tone={tone}>{statusLabel(value)}</StatusBadge>;
}
export function ReadableValue({
  value,
  translate = false,
}: {
  value: JsonValue;
  translate?: boolean;
}) {
  if (value === null) return <span className="inspection-muted">未记录</span>;
  if (typeof value === "boolean") return <span>{value ? "是" : "否"}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="inspection-muted">无</span>;
    const list = (items: JsonValue[]) => (
      <ul className="inspection-values">
        {items.map((v, i) => (
          <li key={i}>
            <ReadableValue value={v} translate={translate} />
          </li>
        ))}
      </ul>
    );
    return (
      <>
        {list(value.slice(0, 8))}
        {value.length > 8 && (
          <details>
            <summary>另外 {value.length - 8} 项</summary>
            {list(value.slice(8))}
          </details>
        )}
      </>
    );
  }
  if (typeof value === "object")
    return (
      <dl className="inspection-fields">
        {Object.entries(value).map(([key, v]) => (
          <div key={key}>
            <dt>{labels[key] ?? key}</dt>
            <dd>
              <ReadableValue
                value={v}
                translate={[
                  "status",
                  "outcome",
                  "action",
                  "reasonCodes",
                  "reviewStatus",
                  "scopeMode",
                  "kind",
                ].includes(key)}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  return (
    <span className="inspection-value">
      {typeof value === "string" && translate ? statusLabel(value) : value}
    </span>
  );
}
export function InspectionFields({
  fields,
}: {
  fields: { label: string; value: JsonValue }[];
}) {
  return (
    <dl className="inspection-fields">
      {fields.map((f, i) => (
        <div key={i}>
          <dt>{f.label}</dt>
          <dd>
            <ReadableValue
              value={f.value}
              translate={["结果", "原因", "验证结果", "范围类型"].includes(
                f.label,
              )}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}
