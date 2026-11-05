/**
 * 功能概述：在 Lifecycle 启动与持久延期到期时，从账本恢复观察积压，不依赖在线入站广播。
 * recoverySourcesSelector 分页扫描启动上界内的来源，按完整 scene 地址选择各流的第一完整页；
 * 开放调度与候选独立完整分页，已有 owner 不因超页被误判为不存在。
 * recoverObservations 登记独立发现进度并复用现有 Candidate/openScope/wake 协议，不确认读取成功。
 * 代码库关系：由 agent.lifecycle 持久订阅调用；使用 SDK observation、账本 Selector 和已有 Kind。
 * 输入输出与副作用：只读原始证据，追加幂等候选及进度；缺少原始运行上下文时保留积压，不伪造权限。
 */
import {
  sceneIdentity,
  type DeepReadonly,
  type InformationAtom,
  type SceneAddress,
} from "@kaguya/schema";
import {
  defineInformationSelector,
  observationCapability,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import { oneShotRequestedInformationKind } from "@kaguya/scheduler";
import {
  observationProgress,
  publishObservationProgress,
  situationObservationContract,
} from "../observation.js";
import {
  inboundTextInformationKind,
  turnCandidateInformationKind,
  observationWakeInformationKind,
} from "../information-kinds.js";
import { scopeOf, observationSignals } from "./observation-state.js";

export const recoverySourcesSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.observation-recovery",
  select: async ({ sourceAtom, ledger }) => {
    const scenes = new Map<string, SceneAddress>();
    let after: string | undefined;
    for (;;) {
      const page = await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        registrationOrder: true,
        order: "asc",
        limit: 1000,
        throughInformationId: sourceAtom.informationId,
        ...(after ? { afterInformationId: after } : {}),
      });
      for (const atom of page) {
        const raw = atom.payload.source as unknown as SceneAddress;
        const source = {
          platform: raw.platform,
          adapterId: raw.adapterId,
          destination: raw.destination,
        };
        scenes.set(sceneIdentity(source), source);
      }
      if (page.length < 1000) break;
      after = page.at(-1)!.informationId;
    }
    const selected = new Map<string, DeepReadonly<InformationAtom>>();
    for (const [sceneId, address] of scenes) {
      const progress = [
        ...(await ledger.find({
          kinds: [observationProgress.kind],
          scopeKey: scopeOf(address),
          payloadContains: { sceneId, consumerId: "agent.situation" },
          registrationOrder: true,
          order: "desc",
          limit: 1000,
        })),
      ].sort(
        (a, b) => Number(b.payload.revision) - Number(a.payload.revision),
      )[0];
      const watermark = progress?.payload.observedThroughInformationId;
      const page = await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        scopeKey: scopeOf(address),
        payloadContains: { source: JSON.parse(JSON.stringify(address)) },
        registrationOrder: true,
        order: "asc",
        limit: 1000,
        throughInformationId: sourceAtom.informationId,
        ...(typeof watermark === "string"
          ? { afterInformationId: watermark }
          : {}),
      });
      for (const atom of page) {
        selected.set(atom.informationId, atom);
      }
      if (progress) selected.set(progress.informationId, progress);
      const latest = page.at(-1);
      if (latest) {
        const contextId = latest.references.find(
          (r) => r.relation === "core:context",
        )?.informationId;
        if (contextId)
          for (const a of await ledger.find({
            informationIds: [contextId],
            limit: 1,
          }))
            selected.set(a.informationId, a);
      }
    }
    // 开放任务必须完整扫描；截断不能成为“没有 owner”的证据。
    let ownerAfter: string | undefined;
    for (;;) {
      const owners = await ledger.find({
        kinds: [
          oneShotRequestedInformationKind.kind,
          turnCandidateInformationKind.kind,
        ],
        openOnly: true,
        registrationOrder: true,
        order: "asc",
        limit: 1000,
        ...(ownerAfter ? { afterInformationId: ownerAfter } : {}),
      });
      for (const owner of owners) selected.set(owner.informationId, owner);
      if (owners.length < 1000) break;
      ownerAfter = owners.at(-1)!.informationId;
    }
    return [...selected.keys()];
  },
});
export async function recoverObservations(
  context: InformationModuleHandlerContext,
  totalWaitBudget: number,
) {
  const selected = await context.select(recoverySourcesSelector);
  const scenes = new Map<string, DeepReadonly<InformationAtom>[]>();
  for (const atom of selected.filter(
    (a) => a.kind === inboundTextInformationKind.kind,
  )) {
    const key = sceneIdentity(atom.payload.source as unknown as SceneAddress);
    scenes.set(key, [...(scenes.get(key) ?? []), atom]);
  }
  for (const inputs of scenes.values()) {
    const latest = inputs.at(-1)!;
    const source = latest.payload.source as unknown as SceneAddress;
    const scopeKey = scopeOf(source);
    const contextId = latest.references.find(
      (r) => r.relation === "core:context",
    )?.informationId;
    if (!contextId || !selected.some((a) => a.informationId === contextId))
      continue;
    const contract = situationObservationContract(source);
    const progress = await context
      .use(observationCapability)
      .discover(contract);
    await publishObservationProgress(context, progress, scopeKey, contextId);
    // 已有调度（包括到期但尚未交付）及开放候选由其持久处理器继续，启动补扫不能重置预算。
    const owned = selected.some(
      (a) =>
        (a.kind === oneShotRequestedInformationKind.kind &&
          (a.payload.input as any)?.scopeKey === scopeKey) ||
        (a.kind === turnCandidateInformationKind.kind &&
          a.payload.scopeKey === scopeKey),
    );
    if (owned) continue;
    const now = context.now().toISOString();
    const candidate = await context.registerOnce(
      "agent.heartbeat.candidate",
      `${context.sourceAtom.informationId}:${sceneIdentity(source)}`,
      turnCandidateInformationKind,
      {
        contextInformationId: contextId,
        openScope: {
          key: scopeKey,
          terminalGroup: "agent.router.turn.terminal",
        },
        payload: {
          triggerInformationId: context.sourceAtom.informationId,
          reason: "recheck",
          dueAt: now,
          firedAt: now,
          platform: source.platform,
          adapterId: source.adapterId,
          destination: source.destination,
          ...(progress.throughInformationId
            ? { unreadAfterInformationId: progress.throughInformationId }
            : {}),
          unreadThroughInformationId: latest.informationId,
          unreadCount: inputs.length,
          signals: [
            ...new Set([
              ...inputs.flatMap((a) =>
                observationSignals((a.payload as any).source, selected),
              ),
              "recheck",
            ]),
          ],
          scopeKey,
          asOf: latest.occurredAt,
          policyVersion: "attention-opportunity.v1",
          rebuildAttempt: 0,
          attempt: 0,
          totalWaitBudget,
        },
        references: [],
      },
    );
    await context.registerOnce(
      "agent.heartbeat.observation.wake",
      `${context.sourceAtom.informationId}:${candidate.informationId}`,
      observationWakeInformationKind,
      {
        contextInformationId: contextId,
        payload: { scopeKey, immediate: false },
        references: [
          {
            relation: "agent:turn-candidate",
            informationId: candidate.informationId,
          },
          ...inputs.map((a) => ({
            relation: "core:uses-context",
            informationId: a.informationId,
          })),
        ],
      },
    );
  }
}
