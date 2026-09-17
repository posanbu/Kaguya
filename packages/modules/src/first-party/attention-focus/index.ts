/**
 * 功能概述：关注租约后台生命周期，消费 Heartflow 的直接开启与回合终态。
 * focusStateSelector 从账本限定 scope 读取最新租约和终态；调度以 grant ID 幂等，重启由 durable delivery 恢复。
 * 成功投递对应的 turn.completed 才续租；silent/failed 关闭本轮所用代际；wait 保留到自然到期。
 * 到期事实先持久化再确认 Scheduler，任一步重试均不重复续租或关闭更新的 grant；日志只记录元数据。
 * inspection 声明本模块的只读机制、领域数据和历史视图，由 Host/Server 投影给开发者控制台。
 */
import { firstPartyInspection } from "../inspection.js";
import { z, type JsonObject } from "@kaguya/schema";
import {
  type InformationKindDefinition,
  defineInformationModule,
  defineInformationSelector,
  onInformation,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import {
  turnCompletedInformationKind,
  turnSilentInformationKind,
  turnFailedInformationKind,
  turnContextCompletedInformationKind,
} from "../information-kinds.js";
import {
  activeFocus,
  focusOpened,
  focusRenewed,
  focusClosed,
  focusExpired,
  focusKinds,
} from "./facts.js";
export const focusStateSelector = defineInformationSelector({
  selectorId: "agent.attention.focus.state",
  select: async ({ sourceAtom, ledger }) => {
    if (sourceAtom.kind === oneShotDueInformationKind.kind) {
      const schedules = await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:status-of",
        direction: "outgoing",
        limit: 1,
      });
      const schedule = schedules.find(
        (a) => a.kind === oneShotRequestedInformationKind.kind,
      );
      if (
        !schedule ||
        (schedule.payload.input as { purpose?: string })?.purpose !==
          "attention-focus"
      )
        return [];
      const grants = await ledger.related({
        from: [schedule.informationId],
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 1,
      });
      return [...schedules, ...grants].map((a) => a.informationId);
    }
    const turns =
      typeof sourceAtom.payload.claimInformationId === "string"
        ? await ledger.find({
            kinds: [turnContextCompletedInformationKind.kind],
            payloadContains: {
              claimInformationId: sourceAtom.payload.claimInformationId,
            },
            limit: 1,
          })
        : [];
    const grants = await ledger.find({
      kinds: [focusOpened.kind, focusRenewed.kind],
      payloadContains: { scopeKey: String(sourceAtom.payload.scopeKey) },
      registrationOrder: true,
      order: "desc",
      limit: 16,
    });
    const terminals = grants.length
      ? await ledger.related({
          from: grants.map((a) => a.informationId),
          relation: "core:status-of",
          direction: "incoming",
          limit: 100,
        })
      : [];
    return [...turns, ...grants, ...terminals].map((a) => a.informationId);
  },
});
export const attentionFocusModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    moduleVersion: "1.0.0",
    definitionId: "agent.attention.focus",
    inspection: firstPartyInspection["agent.attention.focus"],
    displayName: "持续关注",
    summary: "持久化群聊关注租约，成功参与续租，空闲自动到期。",
    description: "关注只提供相关性，不改变 Planner 决策或绕过硬门禁。",
    settingsSchema: z.object({}).strict(),
    consumes: [
      focusOpened,
      focusRenewed,
      turnCompletedInformationKind,
      turnSilentInformationKind,
      turnFailedInformationKind,
      oneShotDueInformationKind,
    ],
    produces: focusKinds,
    selectors: [focusStateSelector],
    promptRenderers: [],
    requires: [oneShotScheduleCapability],
    provides: [],
  },
  create: ({ activation }, lifecycle) => {
    const scheduler = lifecycle.use(oneShotScheduleCapability);
    return {
      provisions: [],
      subscriptions: [
        ...[focusOpened, focusRenewed].map((kind) =>
          onInformation(
            kind,
            {
              subscriptionId: `focus.schedule.${kind.kind}`,
              delivery: "durable",
            },
            async (atom) => {
              await scheduler.schedule({
                operationKey: `focus:${atom.informationId}`,
                sourceInformationId: atom.informationId,
                dueAt: atom.payload.expiresAt,
                input: { purpose: "attention-focus" },
                activation,
              });
            },
          ),
        ),
        onInformation(
          oneShotDueInformationKind,
          { subscriptionId: "focus.expire", delivery: "durable" },
          async (atom, context) => {
            const state = await context.select(focusStateSelector);
            const grant = state.find(
              (a) =>
                a.kind === focusOpened.kind || a.kind === focusRenewed.kind,
            );
            if (!grant) return;
            await context.commitTerminal(
              "agent.attention.focus.terminal",
              grant.informationId,
              focusExpired,
              {
                payload: {
                  scopeKey: String(grant.payload.scopeKey),
                  generation: String(grant.payload.generation),
                  reason: "idle-timeout",
                },
                references: [
                  {
                    relation: "core:status-of",
                    informationId: grant.informationId,
                  },
                ],
              },
            );
            await scheduler.finish({
              scheduleInformationId: atom.payload.scheduleInformationId,
              status: "fired",
            });
          },
        ),
        ...[
          turnCompletedInformationKind,
          turnSilentInformationKind,
          turnFailedInformationKind,
        ].map((kind) =>
          onInformation(
            kind as unknown as InformationKindDefinition<string, JsonObject>,
            {
              subscriptionId: `focus.participation.${kind.kind}`,
              delivery: "durable",
            },
            async (atom, context) => {
              const state = await context.select(focusStateSelector);
              const turn = state.find(
                (a) => a.kind === turnContextCompletedInformationKind.kind,
              );
              if (!turn || turn.payload.isPrivate) return;
              const grant = activeFocus(
                state,
                String(atom.payload.scopeKey),
                atom.occurredAt,
              );
              if (
                !grant ||
                turn.payload.focusInformationId !== grant.informationId
              )
                return;
              if (kind === turnCompletedInformationKind) {
                const duration =
                  Date.parse(String(grant.payload.expiresAt)) -
                  Date.parse(String(grant.payload.startedAt));
                await context.registerOnce(
                  "agent.attention.focus.renew",
                  atom.informationId,
                  focusRenewed,
                  {
                    payload: {
                      scopeKey: String(grant.payload.scopeKey),
                      generation: atom.informationId,
                      startedAt: atom.occurredAt,
                      expiresAt: new Date(
                        Date.parse(atom.occurredAt) + duration,
                      ).toISOString(),
                      reason: "delivered",
                      sourceInformationId: atom.informationId,
                    },
                    references: [
                      {
                        relation: "core:uses-context",
                        informationId: grant.informationId,
                      },
                      {
                        relation: "core:uses-context",
                        informationId: atom.informationId,
                      },
                    ],
                  },
                );
              } else
                await context.commitTerminal(
                  "agent.attention.focus.terminal",
                  grant.informationId,
                  focusClosed,
                  {
                    payload: {
                      scopeKey: String(grant.payload.scopeKey),
                      generation: String(grant.payload.generation),
                      reason:
                        kind === turnSilentInformationKind
                          ? "silent"
                          : "failed",
                    },
                    references: [
                      {
                        relation: "core:status-of",
                        informationId: grant.informationId,
                      },
                    ],
                  },
                );
            },
          ),
        ),
      ],
    };
  },
});
