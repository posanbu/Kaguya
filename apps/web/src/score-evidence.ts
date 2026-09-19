/**
 * 功能概述：读取已脱敏评分证据，防止把缺失、未知版本或不一致证据当作历史计算过程。
 * 主要职责：readScoreEvidence 校验指定分项与已保存贡献值、步骤之和的一致性。
 * 代码库关系：数据来自 Inspection 字段白名单；ScoreRuleDialog 仅展示已持久化事实，不重算评分。
 * 输入输出与副作用：纯读取；未知格式和不完整历史记录返回明确降级状态，文本交由 React 转义。
 */
import { z, type JsonValue } from "@kaguya/schema";

export type ScorePartId =
  "relevance" | "content" | "pressure" | "recentPresencePenalty";
const partSchema = z.object({
  id: z.enum(["relevance", "content", "pressure", "recentPresencePenalty"]),
  value: z.number().finite(),
  facts: z.array(
    z.object({
      label: z.string().min(1),
      value: z.union([z.string(), z.number().finite(), z.boolean()]),
    }),
  ),
  steps: z.array(
    z.object({ label: z.string().min(1), delta: z.number().finite() }),
  ),
  formula: z.string().optional(),
});
type EvidencePart = z.infer<typeof partSchema>;
export type ScoreEvidenceResult =
  | { state: "available"; part: EvidencePart }
  | { state: "missing" | "unsupported" | "inconsistent" };

export function readScoreEvidence(
  raw: JsonValue | undefined,
  id: ScorePartId,
  value: number | undefined,
): ScoreEvidenceResult {
  if (raw === undefined || raw === null) return { state: "missing" };
  if (
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    raw.version !== 1 ||
    !Array.isArray(raw.parts)
  )
    return { state: "unsupported" };
  const candidates = raw.parts.filter(
    (part) =>
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      part.id === id,
  );
  if (!candidates.length) return { state: "missing" };
  if (candidates.length !== 1) return { state: "inconsistent" };
  const parsed = partSchema.safeParse(candidates[0]);
  if (!parsed.success) return { state: "unsupported" };
  const part = parsed.data;
  if (
    value === undefined ||
    part.value !== value ||
    Math.abs(
      part.steps.reduce((sum, step) => sum + step.delta, 0) - part.value,
    ) > 1e-8
  )
    return { state: "inconsistent" };
  return { state: "available", part };
}
