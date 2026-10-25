import {
  lifecycleSnapshotSchema,
  type ActivitySpan,
  type LifecycleSnapshot,
} from "@kaguya/schema";
import { defineInformationKind, defineInformationSelector } from "@kaguya/sdk";

export const lifecycleStateInformationKind = defineInformationKind({
  kind: "agent.lifecycle.state.recorded",
  displayName: "生命周期快照",
  description: "当前活动和合并时间线。节拍延长当前段，不生成长期记忆。",
  log: { enabled: false },
  payloadSchema: lifecycleSnapshotSchema,
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: false, multiple: false },
  },
});
export const lifecycleStateSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.state",
  select: async ({ ledger }) =>
    (
      await ledger.find({
        kinds: [lifecycleStateInformationKind.kind],
        registrationOrder: true,
        order: "desc",
        limit: 1,
      })
    ).map((a) => a.informationId),
});

/** Pure reducer: callers supply a clock. Never mutates a previously frozen snapshot. */
export function advanceActivity(
  previous: LifecycleSnapshot | undefined,
  input: {
    at: string;
    scopeIdleMs: number;
    reason: string;
    state?: "awake" | "asleep";
    scopeKey?: string;
    actual?: boolean;
    busy?: boolean;
  },
): LifecycleSnapshot {
  const next: LifecycleSnapshot = previous
    ? structuredClone(previous)
    : {
        state: "awake",
        at: input.at,
        lastActivityAt: input.at,
        scopeActivityAt: {},
        timeline: [],
      };
  next.at = input.at;
  next.state = input.state ?? next.state;
  if (input.actual) {
    next.lastActivityAt = input.at;
    if (input.scopeKey) next.scopeActivityAt[input.scopeKey] = input.at;
  }
  let scopeKey = input.scopeKey ?? next.timeline.at(-1)?.scopeKey ?? null;
  if (
    scopeKey &&
    !input.busy &&
    Date.parse(input.at) -
      Date.parse(next.scopeActivityAt[scopeKey] ?? next.lastActivityAt) >=
      input.scopeIdleMs
  )
    scopeKey = null;
  if (next.state === "asleep") scopeKey = null;
  const activity: ActivitySpan["activity"] =
    next.state === "asleep"
      ? "sleeping"
      : input.busy
        ? "working"
        : scopeKey
          ? "observing"
          : "idle";
  const current = next.timeline.at(-1);
  if (current?.activity === activity && current.scopeKey === scopeKey)
    current.through = input.at;
  else {
    if (current) current.through = input.at;
    next.timeline.push({
      activity,
      scopeKey,
      startedAt: input.at,
      through: input.at,
      reason: input.reason,
      transition:
        activity === "sleeping"
          ? "好无聊，睡觉了。"
          : activity === "observing"
            ? "听到群里有动静，看看。"
            : activity === "working"
              ? "先处理手头的事。"
              : "暂时没什么事，发会儿呆。",
    });
  }
  const cutoff = Date.parse(input.at) - 600000;
  next.timeline = next.timeline.filter(
    (span, i, all) =>
      i === all.length - 1 || Date.parse(span.through) >= cutoff,
  );
  return next;
}

/** Freeze by registration cutoff: later pulses cannot change an earlier model request. */
export const frozenLifecycleSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.frozen",
  select: async ({ ledger, sourceAtom }) =>
    (
      await ledger.find({
        kinds: [lifecycleStateInformationKind.kind],
        throughInformationId: sourceAtom.informationId,
        registrationOrder: true,
        order: "desc",
        limit: 1,
      })
    ).map((a) => a.informationId),
});
