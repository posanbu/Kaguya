/**
 * 功能概述：为注意力唤醒设计预览提供隔离、可重放的虚构账本，覆盖门禁优先级和历史降级展示。
 * 主要职责：arousalPreviewModule 从正式 Manifest 投影检查 DTO；seedArousalPreview 用正式 schema 校验载荷，
 * 并用 scoreAttentionArousal / decideAttentionArousal 计算 15 条记录的分数、决策和分项计算依据。
 * 代码库关系：仅由 preview/arousal.ts 导入；正式 ModuleSurface 通过 Inspection API 读取上下文引用和记录分页。
 * 输入输出与副作用：只写入调用者提供的演示数据库，不启动 Runtime、不读取用户配置或调用模型。
 * 演示只保留入站、冻结上下文和评估事实，不启动认领流程；context-missing 刻意省略上下文，
 * legacy 保留未知原因码并省略 scoreEvidence，验证旧记录可读且不伪造计算过程。
 */
import {
  attentionArousalCompletedInformationKind,
  attentionArousalModule,
  decideAttentionArousal,
  inboundTextInformationKind,
  scoreAttentionArousal,
  turnContextCompletedInformationKind,
} from "@kaguya/modules";
import {
  freezeInformationAtom,
  inspectionModuleSchema,
  type InformationAtom,
  type JsonObject,
} from "@kaguya/schema";
import type { KaguyaDatabase } from "@kaguya/database";

export const arousalPreviewModule = inspectionModuleSchema.parse({
  ...attentionArousalModule.manifest,
  settingsSchemaFingerprint: "preview",
  selectors: [],
  promptRenderers: [],
  diagnostics: [],
  requires: [],
  provides: [],
  bindings: [],
});

interface PreviewScenario {
  id: string;
  text: string;
  direct?: boolean;
  overrides?: Record<string, unknown>;
  contextMissing?: boolean;
  historicalReasons?: string[];
  policyDigest?: string;
}

const scenarios: PreviewScenario[] = [
  {
    id: "muted-high-score",
    text: "@辉夜 能不能帮我看看这个问题应该怎么解决？",
    overrides: { mentionedSelf: true, muted: true },
  },
  { id: "private-low-score", text: "嗯", direct: true },
  {
    id: "mention-low-score",
    text: "@辉夜 嗯",
    overrides: { mentionedSelf: true, frequency: 0.1 },
  },
  {
    id: "score-threshold-met",
    text: "能不能帮我看看这个要怎么做？",
  },
  { id: "score-below-threshold", text: "今天先把实验记录整理好" },
  {
    id: "wait-budget-exhausted",
    text: "这批输入已经等待三轮",
    overrides: { attempt: 3 },
  },
  {
    id: "context-missing",
    text: "历史上下文已不可用，这条评估仍可查看当时保存的结果",
    contextMissing: true,
  },
  {
    id: "unsafe-high-score",
    text: "帮我看看这个要怎么处理？",
    overrides: { safe: false, focusActive: true },
  },
  {
    id: "destination-unavailable",
    text: "这段私聊的目标在当时不可用",
    direct: true,
    overrides: { destinationAvailable: false },
  },
  {
    id: "frequency-zero",
    text: "你觉得这次实验应该怎么调整？能不能帮我分析一下？",
    overrides: { frequency: 0 },
  },
  {
    id: "reply-low-score",
    text: "[reply:demo-message] 嗯",
    overrides: { repliedToSelf: true, frequency: 0.2 },
  },
  {
    id: "legacy-unknown-reason",
    text: "旧策略保存的决定仍然保留，但原因码已不在当前字典中",
    historicalReasons: ["legacy-policy-evidence"],
    policyDigest: "attention-arousal:legacy-preview-v0",
  },
  {
    id: "focus-active",
    text: "接着上一个话题继续讨论",
    overrides: { focusActive: true },
  },
  {
    id: "long-input",
    text:
      "长输入示例：能不能帮我看看这份讨论记录？" +
      "请对照上次讨论的实验参数，确认最后决定保留哪些条件，并把不同版本的变化和原因说明清楚。".repeat(
        14,
      ),
  },
  {
    id: "recent-presence",
    text: "明天再一起整理剩余的笔记",
    overrides: { recentSelfReplies: 8, recentWindowMessages: 10 },
  },
];

export async function seedArousalPreview(database: KaguyaDatabase) {
  await database.information.synchronizeKinds([
    inboundTextInformationKind.kind,
    turnContextCompletedInformationKind.kind,
    attentionArousalCompletedInformationKind.kind,
  ]);
  const append = async (
    informationId: string,
    kind: string,
    payload: JsonObject,
    occurredAt: string,
    references: InformationAtom["references"] = [],
  ) =>
    database.information.append(
      freezeInformationAtom({
        informationId,
        kind,
        occurredAt,
        source: "preview:arousal",
        payload,
        references,
      }),
      [...new Set(references.map((reference) => reference.relation))].map(
        (relation) => ({ relation, required: false, multiple: true }),
      ),
    );

  for (const [index, scenario] of scenarios.entries()) {
    const id = `demo-arousal-${scenario.id}`;
    const occurredAt = new Date(
      Date.parse("2026-09-19T07:42:00.000Z") - index * 120000,
    ).toISOString();
    const source = {
      adapterId: "demo",
      platform: "qq",
      platformMessageId: `${id}-message`,
      destination: scenario.direct
        ? { kind: "private", userId: "demo-classmate" }
        : { kind: "group", groupId: "demo-research" },
      senderId: "demo-classmate",
      sender: { userId: "demo-classmate", nickname: "演示同学" },
    };
    const inbound = inboundTextInformationKind.payloadSchema.parse({
      text: scenario.text,
      source,
    });
    await append(
      `${id}-input`,
      inboundTextInformationKind.kind,
      inbound,
      occurredAt,
    );
    const context = turnContextCompletedInformationKind.payloadSchema.parse({
      candidateInformationId: `${id}-candidate`,
      claimInformationId: `${id}-claim`,
      scopeKey: scenario.direct
        ? "qq:demo:private:demo-classmate"
        : "qq:demo:group:demo-research",
      asOf: occurredAt,
      backlog: {
        isBacklog: false,
        evaluatedAt: occurredAt,
        oldestInputAgeMs: 0,
        newestInputAgeMs: 0,
        thresholdMs: 300000,
      },
      inputs: [
        {
          informationId: `${id}-input`,
          occurredAt,
          text: scenario.text,
          source,
          identity: {
            terminalInformationId: `${id}-identity`,
            status: "complete",
            scopeMode: "canonical",
          },
        },
      ],
      text: scenario.text,
      source,
      messageCount: 1,
      isPrivate: Boolean(scenario.direct),
      isGroup: !scenario.direct,
      mentionedSelf: false,
      repliedToSelf: false,
      namedSelf: false,
      focusActive: false,
      recentSelfReplies: 0,
      recentWindowMessages: 1,
      idleReachedAverage: false,
      frequency: 1,
      frequencyRuleIndex: null,
      muted: false,
      safe: true,
      destinationAvailable: true,
      stale: false,
      attempt: 0,
      totalWaitBudget: 3,
      ...scenario.overrides,
    });
    const contextId = `${id}-context`;
    if (!scenario.contextMissing)
      await append(
        contextId,
        turnContextCompletedInformationKind.kind,
        context,
        occurredAt,
        [{ relation: "core:uses-context", informationId: `${id}-input` }],
      );
    const scored = scoreAttentionArousal(context);
    const decision = decideAttentionArousal(context);
    const result = attentionArousalCompletedInformationKind.payloadSchema.parse(
      {
        outcome: decision.outcome,
        text: context.text,
        source: context.source,
        candidateInformationId: context.candidateInformationId,
        claimInformationId: context.claimInformationId,
        turnContextInformationId: contextId,
        score: scored.score,
        threshold: 80,
        components: scored.components,
        ...(scenario.id === "legacy-unknown-reason"
          ? {}
          : { scoreEvidence: scored.scoreEvidence }),
        reasonCodes: scenario.historicalReasons ?? decision.reasonCodes,
        missingInputs: [],
        policyDigest: scenario.policyDigest ?? "attention-arousal:maibot-v1",
        settingsDigest: "attention-arousal:preview-v1",
        ...(decision.outcome === "defer"
          ? {
              dueAt: new Date(Date.parse(occurredAt) + 15000).toISOString(),
              delayMs: 15000,
              wakePolicy: "recheckAt",
            }
          : {}),
        attempt: context.attempt,
        totalWaitBudget: context.totalWaitBudget,
      },
    );
    await append(
      id,
      attentionArousalCompletedInformationKind.kind,
      result,
      occurredAt,
      scenario.contextMissing
        ? []
        : [
            { relation: "core:caused-by", informationId: contextId },
            { relation: "core:uses-context", informationId: contextId },
          ],
    );
  }
}
