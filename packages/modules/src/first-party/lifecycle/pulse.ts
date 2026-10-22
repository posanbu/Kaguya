import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  defineInformationSelector,
  defineModuleCapability,
} from "@kaguya/sdk";
import {
  oneShotDueInformationKind,
  oneShotRequestedInformationKind,
} from "@kaguya/scheduler";

export const lifecycleStartedInformationKind = defineInformationKind({
  kind: "agent.lifecycle.started",
  displayName: "生命周期恢复",
  description: "启动后恢复状态与单个节拍，不逐跳补跑。",
  log: { enabled: false },
  payloadSchema: z.object({ instanceId: z.string(), at: z.string() }).strict(),
  references: {},
});
export const lifecycleStartupCapability = defineModuleCapability<{
  start(instanceId: string): Promise<void>;
}>("agent:lifecycle-startup", 1);
export const lifecycleTimersSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.timers",
  select: async ({ sourceAtom, ledger }) => {
    const timers = [
      ...(await ledger.find({
        kinds: [oneShotRequestedInformationKind.kind],
        openOnly: true,
        registrationOrder: true,
        order: "desc",
        limit: 1000,
      })),
    ];
    if (sourceAtom.kind === oneShotDueInformationKind.kind)
      timers.push(
        ...(await ledger.related({
          from: [sourceAtom.informationId],
          relation: "core:status-of",
          direction: "outgoing",
          limit: 1,
        })),
      );
    return [
      ...new Set(
        timers
          .filter(
            (a) =>
              (a.payload.input as { purpose?: string })?.purpose ===
              "lifecycle-pulse",
          )
          .map((a) => a.informationId),
      ),
    ];
  },
});
/** Busy is derived from unresolved model work, not from queued waits. */
export const lifecycleWorkSelector = defineInformationSelector({
  selectorId: "agent.lifecycle.work",
  select: async ({ ledger }) => {
    const [requests, completed] = await Promise.all([
      ledger.find({
        kinds: ["core.model.task.requested"],
        openOnly: true,
        registrationOrder: true,
        order: "desc",
        limit: 1000,
      }),
      ledger.find({
        kinds: [
          "core.model.task.completed",
          "core.model.task.failed",
          "core.model.task.cancelled",
        ],
        registrationOrder: true,
        order: "desc",
        limit: 1,
      }),
    ]);
    const ids = [
      ...new Set(
        [...requests, ...completed].flatMap((atom) =>
          typeof atom.payload.sourceInformationId === "string"
            ? [atom.payload.sourceInformationId]
            : [],
        ),
      ),
    ];
    const sources = ids.length
      ? await ledger.find({
          informationIds: ids,
          limit: Math.max(1, ids.length),
        })
      : [];
    return [...requests, ...completed, ...sources].map((a) => a.informationId);
  },
});
