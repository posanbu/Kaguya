/**
 * 功能概述：供本地 UI 预览和只读接口测试复用的显式演示账本；所有文字、账号和时间均为虚构。
 * 主要职责：associationPreviewModule 从正式 Manifest 投影模块 DTO；seedAssociationPreview 写入查询、终态、排名候选和来源引用。
 * 代码库关系：preview/association.ts 用内存 PGlite 承载本数据，inspection-records.test 验证真实查询；生产启动不导入此文件。
 * 输入输出与副作用：仅写入调用者提供的隔离数据库；不启动 Runtime、模型、消息接入或真实检索。
 */
import { associationModule } from "@kaguya/modules";
import {
  freezeInformationAtom,
  inspectionModuleSchema,
  type JsonObject,
  type InformationAtom,
} from "@kaguya/schema";
import type { KaguyaDatabase } from "@kaguya/database";
const manifest = associationModule.manifest;
export const associationPreviewModule = inspectionModuleSchema.parse({
  ...manifest,
  settingsSchemaFingerprint: "preview",
  selectors: [],
  promptRenderers: [],
  diagnostics: [],
  requires: [],
  provides: [],
  bindings: [],
});
export async function seedAssociationPreview(database: KaguyaDatabase) {
  await database.information.synchronizeKinds([
    "core.message.inbound.text",
    "core.memory.text",
    "agent.association.query",
    "agent.association.candidate",
    "agent.association.completed",
  ]);
  const append = async (
    id: string,
    kind: string,
    payload: JsonObject,
    references: InformationAtom["references"] = [],
    time = "2026-09-19T07:42:00.000Z",
  ) =>
    database.information.append(
      freezeInformationAtom({
        informationId: id,
        kind,
        occurredAt: time,
        source: "preview:association",
        payload,
        references,
      }),
      [...new Set(references.map((ref) => ref.relation))].map((relation) => ({
        relation,
        required: false,
        multiple: true,
      })),
    );
  const queries = [
    ["matched", "上次讨论的实验方案，最后决定用哪一版？"],
    ["empty", "周五的聚餐安排确定了吗？"],
    ["failed", "帮我找一下之前的文献笔记"],
    ["policy-filtered", "<empty>"],
    ["unavailable", "上次提到的测试环境怎么配置？"],
    ["pending", "这条查询还没有写入完成结果"],
    [
      "matched",
      "长文本示例：" +
        "请对照上次讨论的实验参数，确认我们最后决定保留哪些条件，并把不同版本的变化说明清楚。".repeat(
          8,
        ),
    ],
    ["matched", "来源缺失示例：历史记录仍有候选回执，但原文暂不可用"],
    ...Array.from({ length: 6 }, (_, i) => [
      "empty",
      `分页示例 ${i + 1}：查找此前的讨论`,
    ]),
  ];
  await append(
    "demo-source-1",
    "core.message.inbound.text",
    {
      text: "最后采用方案 B：固定数据划分和训练轮数，只调整记忆检索数量。先完成小规模检查，再启动完整实验。",
      source: {
        platform: "qq",
        adapterId: "demo",
        destination: { kind: "group", groupId: "demo-research" },
      },
    },
    [],
    "2026-09-18T09:20:00.000Z",
  );
  await append(
    "demo-source-2",
    "core.message.inbound.text",
    {
      text: "方案 A 同时改了提示词和检索策略，无法区分收益来自哪里；下一轮先保持提示词不变。",
      source: {
        platform: "qq",
        adapterId: "demo",
        destination: { kind: "group", groupId: "demo-research" },
      },
    },
    [],
    "2026-09-18T08:10:00.000Z",
  );
  for (const [index, [status, query]] of queries.entries()) {
    const id = `demo-query-${String(index + 1).padStart(2, "0")}`;
    const time = new Date(
      Date.parse("2026-09-19T07:42:00.000Z") - index * 120000,
    ).toISOString();
    await append(
      id,
      "agent.association.query",
      {
        query: query!,
        queryText: query!,
        scope: {
          platform: "qq",
          adapterId: "demo",
          destination: { kind: "group", groupId: "demo-research" },
        },
        asOf: time,
        method: "sparse-2gram",
        limit: 8,
      },
      [],
      time,
    );
    const candidates = status === "matched" ? (index === 7 ? 1 : 2) : 0;
    for (let rank = candidates - 1; rank >= 0; rank--) {
      await append(
        `${id}-candidate-${rank}`,
        "agent.association.candidate",
        {
          rank,
          strategy: "sparse-2gram",
          reasonCodes: ["sparse-match", "coverage-ranked"],
        },
        [
          { relation: "core:caused-by", informationId: id },
          ...(index === 7
            ? []
            : [
                {
                  relation: "agent:canonical-source",
                  informationId: `demo-source-${rank + 1}`,
                },
              ]),
        ],
        time,
      );
    }
    if (status !== "pending")
      await append(
        `${id}-result`,
        "agent.association.completed",
        {
          status: status!,
          candidateCount: candidates,
          reasonCodes: [
            status === "matched"
              ? "sparse-match"
              : status === "empty"
                ? "no-sparse-match"
                : status === "failed"
                  ? "retrieval-failed"
                  : status === "unavailable"
                    ? "provider-unavailable"
                    : "empty-query-policy",
          ],
        },
        [{ relation: "core:caused-by", informationId: id }],
        time,
      );
  }
}
