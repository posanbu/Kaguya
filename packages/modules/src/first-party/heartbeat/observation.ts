/**
 * 功能概述：Heartbeat 的开放观察投影与只读 Selector，调度提交仍由 index.ts 负责。
 * scopeOf 和 isImmediateObservation 使用 typed 来源判断范围与即时信号；openObservations 按终态过滤开放候选。
 * 三个 Selector 分别恢复 scope schedule、due 来源和观察水位；immediateInState 仅认可成功投递的引用目标。
 * 查询有界且不写账本，保持原有导出对象身份与 Scheduler/Heartflow 外部契约。
 */
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import { defineInformationSelector } from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";
import {
  turnCandidateInformationKind,
  inboundTextInformationKind,
  waitRequestedInformationKind,
  turnCompletedInformationKind,
  turnWaitingInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnSupersededInformationKind,
  turnInterruptedInformationKind,
  turnDecisionInterruptedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";
interface ObservationSource {
  platform?: string;
  adapterId?: string;
  destination?: {
    kind?: string;
    groupId?: string;
    userId?: string;
    channelId?: string;
    id?: string;
  };
  selfId?: string;
  mentions?: readonly { kind: string; id?: string }[];
  replyTo?: { senderId?: string; platformMessageId?: string };
}

export function scopeOf(source: ObservationSource): string {
  const d = source.destination ?? {};
  const id = d.groupId ?? d.userId ?? d.channelId ?? d.id ?? "";
  return `${source.platform}:${source.adapterId}:${d.kind ?? "unknown"}:${id}`;
}

export const heartbeatScopeSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.scope-schedules",
  select: async ({ sourceAtom, ledger }) => {
    const source = (sourceAtom.payload as any).source;
    const scopeKey = source
      ? scopeOf(source)
      : (sourceAtom.payload as any).scopeKey;
    const schedules = await ledger.find({
      kinds: [oneShotRequestedInformationKind.kind],
      openOnly: true,
      scopeKey,
      order: "desc",
      limit: 1,
    });
    for (const schedule of schedules) {
      const input = (schedule.payload as any).input;
      if (!input || input.scopeKey !== scopeKey) continue;
      const terminal = await ledger.related({
        from: [schedule.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 1,
      });
      if (terminal.length) continue;
      const heartbeat = (
        await ledger.related({
          from: [schedule.informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      return heartbeat === undefined
        ? [schedule.informationId]
        : [schedule.informationId, heartbeat.informationId];
    }
    return [];
  },
});

export const heartbeatDueSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.due-source",
  select: async ({ sourceAtom, ledger }) => {
    const requested = await ledger.related({
      from: [sourceAtom.informationId],
      relation: "core:status-of",
      direction: "outgoing",
      limit: 1,
    });
    if (!requested.length) return [];
    const heartbeat = (
      await ledger.related({
        from: [requested[0]!.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 1,
      })
    )[0];
    if (heartbeat === undefined) return [];
    const runtimeContext = await ledger.related({
      from: [heartbeat.informationId],
      relation: "core:context",
      direction: "outgoing",
      limit: 1,
    });
    return [
      heartbeat.informationId,
      ...runtimeContext.map((a) => a.informationId),
    ];
  },
});

export const observationTerminals = [
  turnCompletedInformationKind,
  turnWaitingInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnSupersededInformationKind,
  turnInterruptedInformationKind,
];

export const heartbeatIdleBackoffSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.idle-backoff",
  select: async ({ sourceAtom, ledger }) => {
    const source = (sourceAtom.payload as any).source;
    const scopeKey = source
      ? scopeOf(source)
      : (sourceAtom.payload as any).scopeKey;
    if (!scopeKey) return [];
    const terminals = await ledger.find({
      kinds: observationTerminals.map((kind) => kind.kind),
      scopeKey,
      registrationOrder: true,
      order: "desc",
      limit: 100,
    });
    const selected = [...terminals];
    const latest = terminals[0];
    if (latest) {
      const claim = (
        await ledger.related({
          from: [latest.informationId],
          relation: "agent:turn-claim",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      if (claim) {
        selected.push(claim);
        selected.push(
          ...(
            await ledger.related({
              from: [claim.informationId],
              relation: "agent:turn-claim",
              direction: "incoming",
              limit: 100,
            })
          ).filter(
            (atom) => atom.kind === turnContextCompletedInformationKind.kind,
          ),
        );
      }
    }
    return selected.map((atom) => atom.informationId);
  },
});

export function isImmediateObservation(source: ObservationSource): boolean {
  return (
    source.destination?.kind === "private" ||
    source.destination?.kind === "web" ||
    (source.mentions ?? []).some(
      (mention) =>
        mention.kind === "all" ||
        (source.selfId &&
          mention.kind === "user" &&
          mention.id === source.selfId),
    ) ||
    Boolean(source.selfId && source.replyTo?.senderId === source.selfId)
  );
}

export const heartbeatObservationSelector = defineInformationSelector({
  selectorId: "agent.heartbeat.observation",
  select: async ({ sourceAtom, ledger }) => {
    let anchor = sourceAtom;
    if (sourceAtom.kind === oneShotDueInformationKind.kind) {
      const request = (
        await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        })
      )[0];
      if (!request) return [];
      anchor = (
        await ledger.related({
          from: [request.informationId],
          relation: "core:caused-by",
          direction: "outgoing",
          limit: 1,
        })
      )[0]!;
      if (!anchor) return [];
    }
    const p = anchor.payload as any;
    const source =
      p.source ??
      (p.platform
        ? {
            platform: p.platform,
            adapterId: p.adapterId,
            destination: p.destination,
          }
        : undefined);
    const scopeKey = p.scopeKey ?? (source ? scopeOf(source) : undefined);
    if (!scopeKey) return [];
    const open = await ledger.find({
      kinds: [turnCandidateInformationKind.kind],
      scopeKey,
      registrationOrder: true,
      openOnly: true,
      order: "desc",
      limit: 1000,
    });
    const latest = await ledger.find({
      kinds: [turnCandidateInformationKind.kind],
      scopeKey,
      registrationOrder: true,
      order: "desc",
      limit: 1,
    });
    const candidate = latest[0];
    const selected = new Map(
      [...open, ...latest].map((a) => [a.informationId, a]),
    );
    if (candidate) {
      const interruptedDecisions = await ledger.find({
        kinds: [turnDecisionInterruptedInformationKind.kind],
        scopeKey,
        registrationOrder: true,
        order: "desc",
        limit: 10,
      });
      for (const decision of interruptedDecisions)
        if (decision.payload.candidateInformationId === candidate.informationId)
          selected.set(decision.informationId, decision);
    }
    if (sourceAtom.kind === waitRequestedInformationKind.kind) {
      for (const a of await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 1,
      }))
        selected.set(a.informationId, a);
    }
    // 返回终态以区分唯一开放观察；同 scope 的历史只读取最近一条。
    for (const c of latest)
      for (const a of await ledger.related({
        from: [c.informationId],
        relation: "core:status-of",
        direction: "incoming",
        limit: 10,
      }))
        selected.set(a.informationId, a);
    const target =
      source ??
      (candidate
        ? {
            platform: candidate.payload.platform,
            adapterId: candidate.payload.adapterId,
            destination: candidate.payload.destination,
          }
        : undefined);
    if (target) {
      let watermark = (
        candidate?.payload.sourceInformationIds as string[] | undefined
      )?.at(-1);
      // 恢复合并的来源被冻结在 claim 中；按注册位置取上界，避免回放已爬楼的迟到时间戳输入。
      const terminal = [...selected.values()].find(
        (a) =>
          a.payload.candidateInformationId === candidate?.informationId &&
          observationTerminals.some((k) => k.kind === a.kind),
      );
      if (terminal) {
        const claim = (
          await ledger.related({
            from: [terminal.informationId],
            relation: "agent:turn-claim",
            direction: "outgoing",
            limit: 1,
          })
        )[0];
        const frozen = claim
          ? (
              await ledger.related({
                from: [claim.informationId],
                relation: "agent:turn-claim",
                direction: "incoming",
                limit: 100,
              })
            ).find((a) => a.kind === "agent.turn.context.completed")
          : undefined;
        const ids = frozen
          ? (frozen.payload.inputs as any[]).map((i) => i.informationId)
          : (claim?.references
              .filter((r) => r.relation === "core:uses-context")
              .map((r) => r.informationId) ?? []);
        if (ids.length)
          watermark =
            (
              await ledger.find({
                kinds: [inboundTextInformationKind.kind],
                informationIds: ids,
                registrationOrder: true,
                order: "desc",
                limit: 1,
              })
            )[0]?.informationId ?? watermark;
      }
      const inbounds = await ledger.find({
        kinds: [inboundTextInformationKind.kind],
        ...(watermark ? { afterInformationId: watermark } : {}),
        registrationOrder: true,
        scopeKey,
        payloadContains: {
          source: {
            platform: target.platform,
            adapterId: target.adapterId,
            destination: target.destination,
          },
        },
        order: "desc",
        limit: 1000,
      });
      for (const a of [...inbounds].reverse()) selected.set(a.informationId, a);
    }
    for (const inbound of [...selected.values()].filter(
      (a) => a.kind === inboundTextInformationKind.kind,
    )) {
      const input = (inbound.payload as any).source;
      if (!input?.replyTo?.platformMessageId || isImmediateObservation(input))
        continue;
      const deliveries = await ledger.find({
        kinds: ["core.delivery.delivered"],
        payloadContains: {
          ok: true,
          platform: input.platform,
          adapterId: input.adapterId,
          target: input.destination,
          platformMessageId: input.replyTo.platformMessageId,
        },
        order: "desc",
        limit: 1,
      });
      for (const a of deliveries) selected.set(a.informationId, a);
    }
    return [...selected.keys()];
  },
});

export function immediateInState(
  source: ObservationSource,
  state: readonly DeepReadonly<InformationAtom>[],
): boolean {
  return (
    isImmediateObservation(source) ||
    Boolean(
      source.replyTo?.platformMessageId &&
      state.some(
        (a) =>
          a.kind === "core.delivery.delivered" &&
          a.payload.platformMessageId === source.replyTo?.platformMessageId,
      ),
    )
  );
}

export function openObservations(
  atoms: readonly DeepReadonly<InformationAtom>[],
) {
  return atoms.filter(
    (a) =>
      a.kind === turnCandidateInformationKind.kind &&
      !atoms.some(
        (t) =>
          observationTerminals.some((k) => k.kind === t.kind) &&
          t.payload.candidateInformationId === a.informationId,
      ),
  );
}
