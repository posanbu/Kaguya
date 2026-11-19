/** 将已验证内部来源发布到现有 native Memory，不把内部选择伪装成人类消息。 */
import {
  internalSourceSchema,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import {
  nativeMemoryCapability,
  memoryFormationCapability,
} from "@kaguya/memory";
import { stableId } from "../memory-native/formation.js";
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";

export async function publishInternalMemory(
  atom: Pick<DeepReadonly<InformationAtom>, "informationId" | "payload">,
  context: InformationModuleHandlerContext,
) {
  const source = internalSourceSchema.parse(atom.payload);
  const access = context.use(nativeMemoryCapability);
  const operationId = `internal-memory:${atom.informationId}`;
  if (await access.published(operationId)) return;
  await context.use(memoryFormationCapability).ingest({
    id: atom.informationId,
    scope: source.scope,
    ownerId: "self:kaguya",
    text: source.text,
    occurredAt: source.occurredAt,
    collectedAt: context.now().toISOString(),
    sourceType: "internal",
    participants: [],
    replyTo: null,
  });
  const kind = source.type === "experience" ? "experience" : "self";
  const id = stableId(
    "internal-self",
    source.type === "persona-seed"
      ? `seed:${source.agentId}`
      : atom.informationId,
  );
  const snapshot = await access.prepare({
    scope: source.scope,
    owners: ["self:kaguya"],
    asOf: context.now().toISOString(),
    query: "",
    explicitIds: [id],
  });
  const old = [...snapshot.fixed, ...snapshot.recalled.map((r) => r.node)].find(
    (n) => n.id === id,
  );
  if (await access.published(operationId)) return;
  await access.publish({
    operationId,
    actor: "automatic",
    nodes: [
      {
        expectedRevision: old?.metadata.revision ?? 0,
        node: {
          id,
          content: `${source.type === "persona-seed" ? "角色种子（设定，不是实际经历）" : source.type === "internal-choice" ? "实际内部选择" : source.type === "capability-evidence" ? "能力证据" : "实际活动经历"}：${source.text}`,
          metadata: {
            system: "native-v1",
            kind,
            ownerId: "self:kaguya",
            scope: source.scope,
            occurredAt: source.occurredAt,
            level: source.type === "persona-seed" ? 0 : 1,
            revision: (old?.metadata.revision ?? 0) + 1,
            status: "active",
            locked: false,
            sourceIds: [atom.informationId],
            aliases: [],
            tags: [
              "内部来源",
              source.type,
              ...(source.relatedPersonIds ?? []),
              ...(source.type === "persona-seed"
                ? [stableId("persona-content", source.text)]
                : []),
            ],
            ...(source.relatedPersonIds?.length
              ? { relatedPersonIds: source.relatedPersonIds }
              : {}),
          },
        },
      },
    ],
    edges: [],
  });
}
