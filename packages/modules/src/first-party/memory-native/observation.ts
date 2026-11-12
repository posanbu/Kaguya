/**
 * 功能概述：将独立 Memory 批次的持久冻结证明接到公共 observation 消费进度。
 * memoryObservations 以正规来源注册序列分配页面并替换失败缺口；ackMemoryObservations
 * 以实际成功终态确认完整页，失败不推进水位。正文始终来自已持久 formation request。
 * 代码库关系：memory-native handler 调用，SDK/database 校验 canonical 来源、批次及历史 revision。
 * 输入输出与副作用：登记页面与幂等确认事实；不调用模型，不依赖 Situation 或前台回复。
 */
import {
  canonicalMemorySourceId,
  memoryFormationCapability,
} from "@kaguya/memory";
import {
  nativeMemorySnapshotSchema,
  type DeepReadonly,
  type InformationAtom,
  platformDestinationSchema,
} from "@kaguya/schema";
import {
  observationCapability,
  type InformationModuleHandlerContext,
  type ObservationSnapshot,
} from "@kaguya/sdk";
import {
  nativeMemoryRequested,
  nativeMemorySource,
  nativeMemoryObservationCompleted,
} from "./facts.js";

export async function memoryObservations(
  atom: DeepReadonly<InformationAtom>,
  context: InformationModuleHandlerContext,
) {
  const p = nativeMemoryRequested.payloadSchema.parse(atom.payload),
    frozen = nativeMemorySnapshotSchema.parse(p.existing);
  const [platform, adapterId, kind, id] = JSON.parse(p.scope) as string[];
  const address = {
    platform: platform!,
    adapterId: adapterId!,
    destination: platformDestinationSchema.parse({
      kind,
      ...(kind === "private"
        ? { userId: id }
        : kind === "group"
          ? { groupId: id }
          : id
            ? { conversationId: id }
            : {}),
    }),
  };
  const contract = {
    consumerId: "memory.native",
    policyVersion: "native-formation.v1",
    address,
    kinds: [nativeMemorySource.kind],
    resultKind: nativeMemoryObservationCompleted.kind,
  };
  const sourceInformationIds = p.sources.map((s) =>
    canonicalMemorySourceId(s.id),
  );
  const manifest = {
    version: 1 as const,
    proofKind: "memory-native" as const,
    runInformationId: atom.informationId,
    frozenInformationId: atom.informationId,
    sourceInformationIds,
    knowledgeCutoff: {
      informationId: atom.informationId,
      ...(frozen.cutoff
        ? { memoryPublicationPosition: frozen.cutoff.publicationPosition }
        : {}),
      memoryRevisions: [
        ...frozen.fixed,
        ...frozen.recalled.map((r) => r.node),
      ].map((n) => ({ id: n.id, revision: n.metadata.revision })),
    },
    content: JSON.parse(JSON.stringify(atom.payload)),
  };
  const access = context.use(observationCapability),
    pages: ObservationSnapshot[] = [];
  const through =
    (await context
      .use(memoryFormationCapability)
      .sourceBoundary?.(p.sources.map((s) => s.id))) ??
    sourceInformationIds.at(-1)!;
  for (let i = 0; ; i++) {
    const page = await access.freezeNext({
      ...contract,
      operationKey: `${atom.informationId}:${i}`,
      manifest,
      throughInformationId: through,
      limit: 1000,
    });
    if (!page) break;
    pages.push(page);
    if (!page.hasMore) break;
  }
  for (const pending of await access.pending(contract))
    if (
      pending.sourceInformationIds.every((id) =>
        sourceInformationIds.includes(id),
      )
    ) {
      if (pending.manifest?.frozenInformationId === atom.informationId)
        pages.push(pending);
      else
        pages.push(
          await access.replace(
            pending.observationId,
            `${atom.informationId}:replace:${pending.observationId}`,
            manifest,
          ),
        );
    }
  return [...new Map(pages.map((p) => [p.observationId, p])).values()];
}
export async function ackMemoryObservations(
  pages: readonly ObservationSnapshot[],
  terminal: DeepReadonly<InformationAtom>,
  context: InformationModuleHandlerContext,
) {
  for (const page of pages) {
    if (!page.complete || page.replacementObservationId) continue;
    if (terminal.payload.status !== "completed") {
      await context
        .use(observationCapability)
        .fail(page.observationId, "formation-failed");
      continue;
    }
    const proof = await context.registerOnce(
      "memory.native.observation",
      page.observationId,
      nativeMemoryObservationCompleted,
      {
        payload: {
          observationId: page.observationId,
          operationId: String(terminal.payload.batchId),
        },
        references: [
          ...new Set([
            ...page.sourceInformationIds,
            ...page.contextInformationIds,
            page.manifest!.runInformationId,
            page.manifest!.frozenInformationId,
            terminal.informationId,
            ...(page.manifest!.content.sources as { id: string }[]).map(
              (s) => s.id,
            ),
          ]),
        ].map((informationId) => ({
          relation: "core:uses-context",
          informationId,
        })),
      },
    );
    await context
      .use(observationCapability)
      .finish(page.observationId, proof.informationId);
  }
}
