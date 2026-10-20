import { z, jsonValueSchema } from "@kaguya/schema";
import { defineInformationKind, defineInformationSelector } from "@kaguya/sdk";

/** Durable hook: the body and source boundary are frozen before attention runs. */
export const situationFrozenInformationKind = defineInformationKind({
  kind: "agent.situation.frozen",
  displayName: "情境已冻结",
  description: "原始证据冻结后触发注意模块。冻结本身不确认输入已处理。",
  payloadSchema: z
    .object({
      candidateInformationId: z.string().min(1),
      turnInformationId: z.string().min(1),
      rawInformationId: z.string().min(1),
      historyInformationIds: z.array(z.string()).default([]),
      continuity: z
        .array(
          z.record(
            z.string(),
            z.union([z.null(), z.unknown()]).pipe(jsonValueSchema),
          ),
        )
        .default([]),
      frame: z.record(
        z.string(),
        z.union([z.null(), z.unknown()]).pipe(jsonValueSchema),
      ),
    })
    .strict(),
  log: { enabled: false },
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": { required: true, multiple: true },
  },
});

export const frozenCandidateSelector = defineInformationSelector({
  selectorId: "agent.situation.frozen-candidate",
  select: async ({ sourceAtom, ledger }) =>
    (
      await ledger.find({
        informationIds: [
          String(sourceAtom.payload.candidateInformationId),
          String(sourceAtom.payload.turnInformationId),
        ],
        limit: 2,
      })
    ).map((atom) => atom.informationId),
});
