/** The immutable two-block Memory context shared by Light and Heavy. */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
export const frozenRawContextInformationKind = defineInformationKind({
  kind: "agent.router.memory.context.frozen",
  displayName: "双层原始记忆上下文",
  description:
    "冻结全局与当前范围的可读原始事件及来源，供 Light/Heavy 共用和重放。",
  payloadSchema: z
    .object({
      turnInformationId: z.string().min(1),
      global: z
        .object({ text: z.string(), informationIds: z.array(z.string()) })
        .strict(),
      currentScope: z
        .object({ text: z.string(), informationIds: z.array(z.string()) })
        .strict(),
      overBudget: z.boolean(),
      characterCount: z.number().int().nonnegative(),
    })
    .strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: ["agent.router.turn.context.completed"],
    },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "memory.context.frozen",
      globalCount: payload.global.informationIds.length,
      scopeCount: payload.currentScope.informationIds.length,
      overBudget: payload.overBudget,
    }),
  },
});
