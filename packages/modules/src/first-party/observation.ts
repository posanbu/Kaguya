/**
 * 功能概述：把 Situation 的持久冻结正文接到公共观察端口；模型判断与观察成功分别记录。
 * situationObservationContract 固定独立消费者和读取地址；recordSituationObservations 按账本有界分页，
 * 保存原情境、claim 身份和精确 Memory revision。confirmSituationObservations 只确认完整页，
 * publishObservationProgress 发布连续成功水位，失败页与后续成功页不混淆。
 * 代码库关系：Router/Situation 在冻结和 observe gate 调用，Lifecycle 读取进度事实；数据库能力负责锁与恢复。
 * 输入输出与副作用：只调用 SDK capability/registerOnce，不做模型或平台 I/O；重试复用已落账情境，来源缺失报错。
 */
import {
  z,
  type DeepReadonly,
  type InformationAtom,
  type SceneAddress,
} from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationSelector,
  observationCapability,
  type InformationModuleHandlerContext,
  type ObservationInput,
  type ObservationProgress,
  type ObservationSnapshot,
} from "@kaguya/sdk";

export const observationCompleted = defineInformationKind({
  kind: "agent.observation.completed.v1",
  displayName: "观察读取完成",
  description: "一份有界快照完整读取，不代表模型或行动成功。",
  payloadSchema: z
    .object({
      observationId: z.string(),
      scopeKey: z.string(),
      consumerId: z.string(),
      runInformationId: z.string(),
      frozenInformationId: z.string(),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:uses-context": { required: true, multiple: true },
  },
  log: { enabled: false },
});
export const observationProgress = defineInformationKind({
  kind: "agent.observation.progress.v1",
  displayName: "连续观察进度",
  description: "消费者连续成功范围的可重建投影，保留失败缺口。",
  payloadSchema: z
    .object({
      scopeKey: z.string(),
      sceneId: z.string(),
      consumerId: z.string(),
      revision: z.number().int().nonnegative(),
      observedThroughInformationId: z.string().nullable(),
      throughPosition: z.string(),
      discoveredThroughPosition: z.string(),
      allocatedThroughPosition: z.string(),
    })
    .strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
  },
  log: { enabled: false },
});
export function situationObservationContract(
  address: SceneAddress,
): ObservationInput {
  return {
    consumerId: "agent.situation",
    policyVersion: "observation.v1",
    address: {
      platform: address.platform,
      adapterId: address.adapterId,
      destination: address.destination,
    },
    kinds: ["core.message.inbound.text"],
    resultKind: observationCompleted.kind,
  };
}
export const persistedSituationSelector = defineInformationSelector({
  selectorId: "agent.observation.frozen-situation",
  select: async ({ sourceAtom, ledger }) => {
    const turnId =
      sourceAtom.kind === "agent.router.turn.context.completed"
        ? sourceAtom.informationId
        : undefined;
    return (
      await ledger.find({
        kinds: ["agent.situation.frozen"],
        payloadContains: turnId
          ? { turnInformationId: turnId }
          : {
              candidateInformationId: String(
                sourceAtom.payload.candidateInformationId,
              ),
            },
        registrationOrder: true,
        limit: 1,
      })
    ).map((a) => a.informationId);
  },
});
export async function publishObservationProgress(
  context: InformationModuleHandlerContext,
  progress: ObservationProgress,
  scopeKey: string,
  contextInformationId?: string,
) {
  await context.registerOnce(
    "agent.observation.progress",
    JSON.stringify([
      progress.sceneId,
      progress.consumerId,
      progress.revision,
      progress.discoveredThroughPosition,
    ]),
    observationProgress,
    {
      ...(contextInformationId ? { contextInformationId } : {}),
      payload: {
        scopeKey,
        sceneId: progress.sceneId,
        consumerId: progress.consumerId,
        revision: progress.revision,
        observedThroughInformationId: progress.throughInformationId,
        throughPosition: progress.throughPosition,
        discoveredThroughPosition: progress.discoveredThroughPosition,
        allocatedThroughPosition: progress.allocatedThroughPosition,
      },
    },
  );
}
export async function recordSituationObservations(
  context: InformationModuleHandlerContext,
  turn: DeepReadonly<InformationAtom>,
  frozen: DeepReadonly<InformationAtom>,
): Promise<readonly ObservationSnapshot[]> {
  const payload = turn.payload as any;
  const frame = frozen.payload.frame as any;
  const access = context.use(observationCapability);
  const contract = situationObservationContract(payload.source);
  const nodes = [
    ...(frame.memory?.fixed ?? []),
    ...(frame.memory?.recalled ?? []).map((r: any) => r.node),
    ...(frame.memory?.personCandidates ?? []).map((p: any) => p.summary),
  ];
  const sourceInformationIds = (
    payload.inputs as { informationId: string }[]
  ).map((i) => i.informationId);
  const manifest = {
    version: 1 as const,
    runInformationId: String(payload.claimInformationId),
    frozenInformationId: frozen.informationId,
    sourceInformationIds,
    knowledgeCutoff: {
      informationId: frozen.informationId,
      memoryRevisions: [
        ...new Map<string, { id: string; revision: number }>(
          nodes.map((n: any) => [
            n.id,
            { id: n.id, revision: n.metadata.revision },
          ]),
        ).values(),
      ],
    },
    content: frame,
  };
  const pages: ObservationSnapshot[] = [];
  for (let index = 0; ; index++) {
    const page = await access.freezeNext({
      ...contract,
      operationKey: `${turn.informationId}:${index}`,
      throughInformationId: String(payload.observedThroughInformationId),
      limit: 1000,
      manifest,
    });
    if (!page) break;
    pages.push(page);
    if (!page.hasMore) break;
  }
  const evidence = new Set(
    (frame.background.evidence as { id: string }[]).map((e) => e.id),
  );
  const readable = new Set(
    sourceInformationIds.filter((id) => evidence.has(id)),
  );
  for (const pending of await access.pending(contract)) {
    if (
      !pending.complete &&
      pending.sourceInformationIds.every((id) => readable.has(id))
    ) {
      pages.push(
        await access.replace(
          pending.observationId,
          `${turn.informationId}:replace:${pending.observationId}`,
          manifest,
        ),
      );
    }
  }
  return pages;
}
export async function confirmSituationObservations(
  context: InformationModuleHandlerContext,
  turn: DeepReadonly<InformationAtom>,
  frozen: DeepReadonly<InformationAtom>,
) {
  const access = context.use(observationCapability);
  const pages = await recordSituationObservations(context, turn, frozen);
  const contract = situationObservationContract((turn.payload as any).source);
  // Deferred observations retain their original frame. A later complete read may acknowledge those exact pages.
  const readable = new Set(
    (turn.payload.inputs as { informationId: string }[]).map(
      (i) => i.informationId,
    ),
  );
  const evidence = new Set(
    ((frozen.payload.frame as any).background.evidence as { id: string }[]).map(
      (e) => e.id,
    ),
  );
  if (![...readable].every((id) => evidence.has(id)))
    throw new Error("Observation input missing from frozen frame");
  const pending = await access.pending(contract);
  for (const page of [
    ...new Map(
      [
        ...pages,
        ...pending.filter(
          (p) =>
            p.complete &&
            p.sourceInformationIds.every((id) => readable.has(id)),
        ),
      ].map((p) => [p.observationId, p]),
    ).values(),
  ]) {
    if (!page.complete || page.replacementObservationId) continue;
    if (!page.manifest) throw new Error("Observation manifest missing");
    const proof = await context.registerOnce(
      "agent.observation.completed",
      page.observationId,
      observationCompleted,
      {
        payload: {
          observationId: page.observationId,
          scopeKey: String(turn.payload.scopeKey),
          consumerId: page.consumerId,
          runInformationId: page.manifest.runInformationId,
          frozenInformationId: page.manifest.frozenInformationId,
        },
        references: [
          ...new Set([
            ...page.sourceInformationIds,
            ...page.contextInformationIds,
            page.manifest.runInformationId,
            page.manifest.frozenInformationId,
          ]),
        ].map((informationId) => ({
          relation: "core:uses-context",
          informationId,
        })),
      },
    );
    await access.finish(page.observationId, proof.informationId);
  }
  await publishObservationProgress(
    context,
    (await access.progress(contract))!,
    String(turn.payload.scopeKey),
  );
}
