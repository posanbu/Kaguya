import { memorySourceSchema } from "@kaguya/memory";
import { personEvidenceSchema, z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
export const nativeMemoryRequested = defineInformationKind({
  kind: "memory.native.formation.requested.v1",
  displayName: "记忆形成与整理请求",
  description: "冻结同一作用域的来源、已有记忆版本和整理输入。",
  payloadSchema: z
    .object({
      batchId: z.string(),
      scope: z.string(),
      sources: z.array(memorySourceSchema),
      existing: z.record(z.string(), z.json()),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:uses-context": { required: true, multiple: true },
  },
  log: { enabled: false },
});
export const nativeMemoryCompleted = defineInformationKind({
  kind: "memory.native.formation.completed.v1",
  displayName: "记忆形成与整理结果",
  description: "记录发布结果或失败。原始来源始终保留。",
  payloadSchema: z
    .object({
      batchId: z.string(),
      scope: z.string(),
      status: z.enum(["completed", "rejected", "failed"]),
      nodeIds: z.array(z.string()),
      reason: z.string(),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:status-of": { required: true, multiple: false },
  },
  log: { enabled: false },
});
export const nativeMemoryRevision = defineInformationKind({
  kind: "memory.native.revision.v1",
  displayName: "记忆版本发布",
  description: "与图和文本索引在同一事务中追加完整修订。",
  payloadSchema: z.record(z.string(), z.json()),
  references: {},
  log: { enabled: false },
});
export const formationOutputSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            key: z.string().min(1),
            evidence: personEvidenceSchema.exactOptional(),
            expressionType: z
              .enum(["habit", "example", "qq-resource"])
              .nullable()
              .default(null),
            kind: z.enum([
              "person",
              "conversation",
              "self",
              "experience",
              "expression",
            ]),
            ownerId: z.string().min(1),
            scope: z.string().min(1),
            level: z.number().int().nonnegative(),
            content: z.string().min(1).max(4000),
            sourceIds: z.array(z.string()).min(1),
            tags: z.array(z.string()),
            aliases: z.array(z.string()),
            status: z.enum(["active", "invalidated", "archived"]),
          })
          .strict(),
      )
      .max(24),
    edges: z
      .array(
        z
          .object({
            sourceId: z.string(),
            targetId: z.string(),
            relation: z.string().min(1),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const nativeMemoryRetry = defineInformationKind({
  kind: "memory.native.formation.retry.v1",
  displayName: "记忆批次重试",
  description: "重新排队失败批次，保留原始失败记录。",
  payloadSchema: z.object({ batchId: z.string(), scope: z.string() }).strict(),
  references: { "core:context": { required: true, multiple: false } },
  log: { enabled: false },
});
