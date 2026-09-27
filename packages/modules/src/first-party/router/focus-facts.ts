/**
 * 功能概述：关注租约的不可变生命周期及纯投影；Router 冻结输入并负责租约调度和终态。
 * grant 表达一次直接唤醒或成功参与，generation 绑定来源事实；terminal 只关闭对应 grant，旧到期不能关闭新租约。
 * activeFocus 只读取同 scope、指定时刻有效且未关闭的最近 grant；没有进程内状态或 I/O。
 */
import { z, type DeepReadonly, type InformationAtom } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
const payloadSchema = z
  .object({
    scopeKey: z.string().min(1),
    generation: z.string().min(1),
    startedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    reason: z.string().min(1),
    sourceInformationId: z.string().min(1),
  })
  .strict();
function grant<
  K extends "agent.router.focus.opened" | "agent.router.focus.renewed",
>(kind: K) {
  return defineInformationKind({
    kind,
    displayName: {
      "agent.router.focus.opened": "关注已开启",
      "agent.router.focus.renewed": "关注已续租",
    }[kind],
    description: "按聊天范围记录关注租约及来源，重放复用同一事实。",
    payloadSchema,
    references: {
      "core:context": { required: false, multiple: false },
      "core:caused-by": { required: true, multiple: false },
      "core:uses-context": { required: true, multiple: true },
    },
    log: {
      enabled: true,
      level: "debug",
      project: ({ payload }) => ({
        event: kind,
        scopeKey: payload.scopeKey,
        reason: payload.reason,
        expiresAt: payload.expiresAt,
      }),
    },
  });
}
export const focusOpened = grant("agent.router.focus.opened");
export const focusRenewed = grant("agent.router.focus.renewed");
function terminal<
  K extends "agent.router.focus.closed" | "agent.router.focus.expired",
>(kind: K) {
  return defineInformationKind({
    kind,
    displayName: {
      "agent.router.focus.closed": "关注已关闭",
      "agent.router.focus.expired": "关注已到期",
    }[kind],
    description: "关闭指定代际的关注租约，不影响后续直接唤醒。",
    payloadSchema: z
      .object({
        scopeKey: z.string(),
        reason: z.string(),
        generation: z.string(),
      })
      .strict(),
    references: {
      "core:context": { required: false, multiple: false },
      "core:caused-by": { required: true, multiple: false },
      "core:status-of": { required: true, multiple: false },
    },
    log: {
      enabled: true,
      level: "debug",
      project: ({ payload }) => ({ event: kind, ...payload }),
    },
  });
}
export const focusClosed = terminal("agent.router.focus.closed");
export const focusExpired = terminal("agent.router.focus.expired");
export const focusKinds = [
  focusOpened,
  focusRenewed,
  focusClosed,
  focusExpired,
];
export function activeFocus(
  atoms: readonly DeepReadonly<InformationAtom>[],
  scopeKey: string,
  asOf: string,
) {
  const now = Date.parse(asOf);
  const grants = atoms
    .filter(
      (a) =>
        (a.kind === focusOpened.kind || a.kind === focusRenewed.kind) &&
        a.payload.scopeKey === scopeKey,
    )
    .sort(
      (a, b) =>
        Date.parse(String(b.payload.startedAt)) -
          Date.parse(String(a.payload.startedAt)) ||
        b.informationId.localeCompare(a.informationId),
    );
  // 关闭最新代际时不可回退到更早的仍未到期 grant。
  const latest = grants.find(
    (a) => Date.parse(String(a.payload.startedAt)) <= now,
  );
  if (!latest || Date.parse(String(latest.payload.expiresAt)) <= now)
    return undefined;
  if (
    atoms.some(
      (a) =>
        (a.kind === focusClosed.kind || a.kind === focusExpired.kind) &&
        a.references.some(
          (r) =>
            r.relation === "core:status-of" &&
            r.informationId === latest.informationId,
        ),
    )
  )
    return undefined;
  return latest;
}
