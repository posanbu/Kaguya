/** 持续活动的应用流程。复用 Model Task、Memory、观察、工具循环和 one-shot。 */
import {
  z,
  type DeepReadonly,
  type InformationAtom,
  type JsonObject,
} from "@kaguya/schema";
import {
  actionOutcomeSchema,
  continuityCapability,
  continuityKinds,
  continuityPolicyKind,
  continuityInternalKind,
  continuityExecutionFrozenKind,
  continuityActivityKind,
  subjectiveStateSchema,
  defineInformationKind,
  defineInformationModule,
  defineInformationSelector,
  defineModuleCapability,
  onInformation,
  observationCapability,
  type InformationModuleHandlerContext,
  type ContinuityView,
  type Activity,
} from "@kaguya/sdk";
import {
  nativeMemoryCapability,
  memoryFormationCapability,
  memoryScope,
} from "@kaguya/memory";
import {
  oneShotDueInformationKind,
  oneShotScheduleCapability,
} from "@kaguya/scheduler";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { continuityTemplateDeclaration } from "../../prompt-declarations.js";
import type {
  CreateHeavyModuleOptions,
  AgentIdentity,
} from "../heavy/index.js";
import { stableId } from "../memory-native/formation.js";
import {
  lifecycleStartedInformationKind,
  lifecycleStartupCapability,
} from "../lifecycle/pulse.js";
import { publishInternalMemory } from "./memory.js";

export const continuitySettingsSchema = z
  .object({
    autonomous: z.boolean().default(false).meta({
      title: "自主运行",
      public: true,
      description:
        "启用前需配置 Memory、执行工具及作用域。每天最多 24 次自主模型调用。",
    }),
    scope: z
      .string()
      .min(1)
      .default(
        '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]',
      )
      .refine((v) => {
        try {
          const a = JSON.parse(v);
          return (
            Array.isArray(a) &&
            a.length === 4 &&
            a.every((x) => typeof x === "string") &&
            ["private", "group", "web"].includes(String(a[2]))
          );
        } catch {
          return false;
        }
      })
      .meta({
        title: "自主活动范围",
        public: true,
        description: "使用已配置环境绑定的完整范围。私人正文不会注入其他会话。",
      }),
    personaImportRevision: z.string().min(1).max(100).default("1").meta({
      title: "角色导入策略版本",
      public: true,
      description:
        "首次启用时导入角色种子。角色资源的明确修改在应用配置后进入同一 Memory 修订历史。",
    }),
    subjectiveTtlMs: z
      .number()
      .int()
      .min(1000)
      .max(86400000)
      .default(1800000)
      .meta({
        title: "主观状态有效期",
        public: true,
        description: "默认三十分钟。过期不会生成情绪变化。",
      }),
  })
  .strict();
const appraisalOutput = z
  .object({
    subjective: subjectiveStateSchema.nullable(),
    reason: z.string().max(2000),
    feedback: z
      .array(
        z
          .object({
            activityId: z.string(),
            feedbackInformationId: z.string(),
            outcome: z.enum(["fulfilled", "declined"]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export const continuityChoiceOutputSchema = z
  .object({
    action: z.enum(["wait", "create", "continue", "abandon"]),
    activityId: z.string().nullable(),
    title: z.string().max(1000),
    goal: z.string().max(4000),
    nextStep: z.string().max(4000),
    reason: z.string().max(2000),
    checkAfterMs: z.number().int().min(60000).max(86400000),
  })
  .strict();
/** 选择只能引用本次冻结输入中的开放活动，非法 ID 进入原有结构恢复预算。 */
export function continuityChoiceFor(view: Pick<ContinuityView, "activities">) {
  const ids = view.activities
    .filter((a) => ["candidate", "active", "waiting"].includes(a.state))
    .map((a) => a.id);
  return continuityChoiceOutputSchema
    .extend({ activityId: z.enum(ids).nullable() })
    .superRefine((choice, ctx) => {
      if (["continue", "abandon"].includes(choice.action) && !choice.activityId)
        ctx.addIssue({
          code: "custom",
          path: ["activityId"],
          message: "Copy the existing activity id from the frozen input",
        });
      if (
        choice.action === "create" &&
        (!choice.title.trim() || !choice.goal.trim())
      )
        ctx.addIssue({
          code: "custom",
          path: ["goal"],
          message: "A new activity requires a concrete title and goal",
        });
    });
}
const executionOutput = z
  .object({
    status: z.enum(["continue", "complete", "waiting", "failed"]),
    summary: z.string().max(4000),
    nextStep: z.string().max(4000),
    completedSteps: z.array(z.string().max(2000)).max(100),
    resources: z
      .array(
        z
          .object({
            receiptId: z.string(),
            artifactId: z.string(),
            role: z.enum(["source", "note", "verification"]),
            verifies: z
              .string()
              .nullable()
              .describe("核对的笔记 artifactId 或已有资源 ID，其他资源填 null"),
          })
          .strict(),
      )
      .max(50),
    checkAfterMs: z.number().int().min(60000).max(86400000),
  })
  .strict();
export const continuityCycleKind = defineInformationKind({
  kind: "agent.continuity.cycle.v1",
  displayName: "活动检查结果",
  description: "保存活动检查终态，不把模型完成当成执行完成。",
  payloadSchema: z
    .object({
      sourceId: z.string(),
      status: z.enum(["completed", "waiting", "superseded", "failed"]),
      reason: z.string(),
      activityId: z.string().nullable(),
    })
    .strict(),
  references: {
    "core:uses-context": { required: false, multiple: true },
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: false, multiple: false },
  },
  log: { enabled: false },
});
const selfReady = defineInformationKind({
  kind: "agent.continuity.self-ready.v1",
  displayName: "角色种子已进入记忆",
  description: "由唯一持久 Memory 消费者确认导入后，再开始状态与活动选择。",
  payloadSchema: z.object({ sourceId: z.string(), scope: z.string() }).strict(),
  references: {
    "core:caused-by": { required: true, multiple: false },
    "core:context": { required: true, multiple: false },
    "core:uses-context": { required: false, multiple: true },
  },
  log: { enabled: false },
});
const selected = defineInformationSelector({
  selectorId: "agent.continuity.cycle-context",
  select: async ({ sourceAtom, ledger }) => {
    const policy = await ledger.find({
      kinds: [continuityPolicyKind.kind],
      payloadContains: { agentId: "kaguya" },
      registrationOrder: true,
      order: "desc",
      limit: 1,
    });
    const refs = [
      ...new Set([
        ...sourceAtom.references.map((r) => r.informationId),
        ...policy.flatMap((a) => a.references.map((r) => r.informationId)),
      ]),
    ];
    const cycles = await ledger.find({
      kinds: [continuityCycleKind.kind],
      payloadContains: { sourceId: sourceAtom.informationId },
      limit: 1,
    });
    const schedules = (
      await ledger.related({
        from: [sourceAtom.informationId],
        relation: "core:caused-by",
        direction: "incoming",
        limit: 100,
      })
    ).filter(
      (a) =>
        a.kind === "core.schedule.one-shot.requested" &&
        (a.payload.input as any)?.consumer === "agent.continuity",
    );
    const related = refs.length
      ? await ledger.find({ informationIds: refs, limit: 100 })
      : [];
    return [...cycles, ...related, ...schedules].map((a) => a.informationId);
  },
});
const deliveryCauses = defineInformationSelector({
  selectorId: "agent.continuity.delivery-causes",
  select: async ({ sourceAtom, ledger }) => {
    const ids = new Set<string>();
    let from = [sourceAtom.informationId];
    for (let depth = 0; depth < 16 && from.length; depth++) {
      const atoms = await ledger.related({
        from,
        relation: "core:caused-by",
        direction: "outgoing",
        limit: 10,
      });
      from = atoms
        .filter((a) => !ids.has(a.informationId))
        .map((a) => a.informationId);
      from.forEach((id) => ids.add(id));
    }
    return [...ids];
  },
});
export const continuityAppraisalCapability = defineModuleCapability<{
  appraise(
    atom: DeepReadonly<InformationAtom>,
    scope: string,
    context: InformationModuleHandlerContext,
  ): Promise<void>;
}>("agent:continuity-appraisal", 1);

export function createContinuityModule(
  options: Pick<
    CreateHeavyModuleOptions,
    "modelTaskCapability" | "deliveryDeliveredInformationKind"
  > & { template: string; identity: AgentIdentity },
) {
  const render = createPromptTemplateRenderer({
    kind: "state",
    templateId: "agent.continuity.v1",
    main: { ...continuityTemplateDeclaration, content: options.template },
  });
  return defineInformationModule({
    manifest: {
      definitionId: "agent.continuity",
      displayName: "持续自我与活动",
      category: "agent",
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      summary: "保存自我来源、主观状态、活动进度和每日自主调用预算。",
      description:
        "自主运行默认关闭。活动和承诺复用真实行动回执，结束后进入现有 Memory。",
      settingsSchema: continuitySettingsSchema,
      consumes: [
        continuityPolicyKind,
        continuityInternalKind,
        continuityActivityKind,
        selfReady,
        lifecycleStartedInformationKind,
        oneShotDueInformationKind,
        ...(options.deliveryDeliveredInformationKind
          ? [options.deliveryDeliveredInformationKind]
          : []),
      ],
      produces: [...continuityKinds, continuityCycleKind, selfReady],
      selectors: [selected, deliveryCauses],
      promptTemplates: [continuityTemplateDeclaration],
      promptRenderers: [],
      requires: [
        continuityCapability,
        nativeMemoryCapability,
        memoryFormationCapability,
        options.modelTaskCapability,
        oneShotScheduleCapability,
        observationCapability,
        lifecycleStartupCapability,
      ],
      provides: [continuityAppraisalCapability],
      inspection: {
        mechanism: [
          "主观评价先保存，再选择活动。",
          "自主调用每天最多二十四次，重启不清零。",
          "外部结果、投递与反馈分别保存。",
        ],
        views: [
          {
            id: "activities",
            title: "活动版本",
            description: "查看持久活动的版本、状态和下一步。",
            kinds: ["agent.continuity.activity.v1"],
            fields: [
              { path: "activity.title", label: "活动" },
              { path: "activity.state", label: "状态" },
              { path: "activity.nextStep", label: "下一步" },
            ],
          },
        ],
      },
    },
    create: ({ settings, activation }) => {
      const agentId = "kaguya";
      const freeze = async (
        atom: DeepReadonly<InformationAtom>,
        scope: string,
        phase: string,
        context: InformationModuleHandlerContext,
        activityId?: string,
      ) => {
        const memory = await context.use(nativeMemoryCapability).freeze({
          scope,
          owners: ["self:kaguya", `conversation:${scope}`],
          asOf: context.now().toISOString(),
          query: "当前兴趣、关注、活动和约定",
        });
        return context.use(continuityCapability).freeze({
          agentId,
          scope,
          operationId: `${atom.informationId}:${phase}`,
          basis: [atom.informationId],
          memory,
          ...(activityId ? { activityId } : {}),
        });
      };
      const appraise = async (
        atom: DeepReadonly<InformationAtom>,
        scope: string,
        context: InformationModuleHandlerContext,
      ) => {
        const access = context.use(continuityCapability);
        const current = await access.read(agentId, scope);
        if (
          !current ||
          !current.policy.enabled ||
          current.budget.remaining === 0
        )
          return;
        const f = await freeze(atom, scope, "appraisal-input", context);
        const result = await context.use(options.modelTaskCapability).execute({
          task: {
            taskId: "agent.continuity.appraise",
            outputMode: "object",
            outputSchema: appraisalOutput,
            allowedTiers: ["light"],
          },
          activation,
          sourceInformationId: f.informationId,
          contextInformationId: f.view.contextInformationId,
          selectionPolicy: { tier: "light" },
          contextAtoms: [f.atom, atom],
          prompt: render([
            { name: "phase", content: "评价", informationIds: [] },
            {
              name: "context",
              content: JSON.stringify({
                ...f.atom.payload,
                event: atom.payload,
              }),
              informationIds: [f.informationId, atom.informationId],
            },
          ]),
        });
        if (result.status !== "completed") return;
        const output = appraisalOutput.parse(result.output);
        if (output.subjective) {
          try {
            await access.evaluate({
              agentId,
              operationId: `${atom.informationId}:appraisal`,
              expectedRevision: f.view.revision,
              scope,
              subjective: output.subjective,
              basis: [result.terminalInformationId],
            });
          } catch (error) {
            if (!(
              error instanceof Error && error.message === "revision-conflict"
            ))
              throw error;
          }
        }
        for (const feedback of output.feedback) {
          try {
            await access.feedback({
              agentId,
              ...feedback,
              completedInformationId: result.terminalInformationId,
            });
          } catch (error) {
            if (!(
              error instanceof Error &&
              [
                "feedback-activity-unavailable",
                "feedback-unproved",
                "feedback-outside-evaluation",
                "revision-conflict",
                "unproven-fulfillment",
              ].includes(error.message)
            ))
              throw error;
          }
        }
      };
      const schedule = async (
        context: InformationModuleHandlerContext,
        sourceId: string,
        view: ContinuityView,
        afterMs: number,
        scope = settings.scope,
      ) => {
        if (!view.policy.enabled) return;
        const delay =
          view.budget.remaining === 0
            ? (() => {
                // 以绝对时间寻找 Agent 的下一天，兼容时区和夏令时。不回放离线节拍。
                const day = (d: Date) =>
                  new Intl.DateTimeFormat("en-CA", {
                    timeZone: view.policy.timeZone,
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                  }).format(d);
                const now = context.now();
                let next = new Date(now.getTime() + 60000);
                while (day(next) === day(now))
                  next = new Date(next.getTime() + 60000);
                return next.getTime() - now.getTime();
              })()
            : afterMs;
        const prior = (await context.select(selected)).find(
          (a) =>
            a.kind === "core.schedule.one-shot.requested" &&
            a.payload.operationKey === `continuity:${sourceId}`,
        );
        const dueAt =
          typeof prior?.payload.dueAt === "string"
            ? prior.payload.dueAt
            : new Date(context.now().getTime() + delay).toISOString();
        const timer = await context.use(oneShotScheduleCapability).schedule({
          operationKey: `continuity:${sourceId}`,
          sourceInformationId: sourceId,
          dueAt,
          input: { consumer: "agent.continuity", scope },
          activation,
        });
        for (const a of view.activities.filter(
          (a) =>
            ["candidate", "active", "waiting"].includes(a.state) && !a.inFlight,
        )) {
          try {
            await context.use(continuityCapability).change({
              agentId,
              operationId: `${sourceId}:check-at:${a.id}`,
              activityId: a.id,
              expectedRevision: a.revision,
              change: {
                nextCheckAt: dueAt,
                ...(view.budget.remaining === 0
                  ? { state: "waiting", reason: "今日自主调用预算已用尽" }
                  : {}),
              },
              basis: [timer.scheduleInformationId],
            });
          } catch (error) {
            if (!(
              error instanceof Error && error.message === "revision-conflict"
            ))
              throw error;
          }
        }
      };
      const cycle = async (
        atom: DeepReadonly<InformationAtom>,
        context: InformationModuleHandlerContext,
        scope = settings.scope,
      ) => {
        const access = context.use(continuityCapability);
        if (
          (await context.select(selected)).some(
            (a) => a.kind === continuityCycleKind.kind,
          )
        )
          return;
        let activity: Activity | undefined;
        let status: "completed" | "waiting" | "superseded" | "failed" =
          "waiting";
        let reason = "no-action";
        let recoverable = false;
        try {
          let view = await access.read(agentId, scope);
          const recovery = await access.frozen(
            agentId,
            `${atom.informationId}:execution-input`,
            scope,
          );
          if (
            !view?.policy.enabled ||
            (view.activities.some((a) => a.inFlight) && !recovery)
          )
            return;
          const self = await context.use(nativeMemoryCapability).prepare({
            scope: "shared",
            owners: ["self:kaguya"],
            asOf: context.now().toISOString(),
            query: "",
          });
          if (
            !self.fixed.some(
              (n) =>
                n.metadata.locked ||
                n.metadata.tags.includes(
                  stableId("persona-content", options.identity.persona),
                ),
            )
          )
            return;
          if (!view.budget.remaining && !recovery) {
            await schedule(context, atom.informationId, view, 60000, scope);
            return;
          }
          await appraise(atom, scope, context);
          const f = await freeze(atom, scope, "choice-input", context);
          const result = await context
            .use(options.modelTaskCapability)
            .execute({
              task: {
                taskId: "agent.continuity.choose",
                outputMode: "object",
                outputSchema: continuityChoiceFor(f.view),
                allowedTiers: ["light"],
              },
              activation,
              sourceInformationId: f.informationId,
              contextInformationId: f.view.contextInformationId,
              selectionPolicy: { tier: "light" },
              contextAtoms: [f.atom],
              prompt: render([
                { name: "phase", content: "选择", informationIds: [] },
                {
                  name: "context",
                  content: JSON.stringify(f.atom.payload),
                  informationIds: [f.informationId],
                },
              ]),
            });
          if (result.status !== "completed") {
            reason = `choice-${result.status}`;
            view = (await access.read(agentId, scope))!;
            await schedule(context, atom.informationId, view, 300000, scope);
            return;
          }
          const choice = continuityChoiceOutputSchema.parse(result.output);
          if (choice.action === "wait") {
            reason = choice.reason;
            await schedule(
              context,
              atom.informationId,
              (await access.read(agentId, scope))!,
              choice.checkAfterMs,
              scope,
            );
            return;
          }
          if (choice.action === "create") {
            if (!choice.goal.trim() || !choice.title.trim())
              throw new Error("empty-activity-goal");
            activity = await access.create({
              agentId,
              operationId: `${atom.informationId}:create`,
              expectedRevision: f.view.revision,
              activity: {
                id: stableId("activity", f.informationId),
                scope,
                kind: "plan",
                title: choice.title,
                goal: choice.goal,
                nextStep: choice.nextStep,
                sources: [result.terminalInformationId, f.informationId],
                memoryDependencies: [
                  ...(f.atom.payload.memory as any).fixed,
                  ...(f.atom.payload.memory as any).recalled.map(
                    (r: any) => r.node,
                  ),
                ].map((n: any) => ({
                  id: n.id,
                  revision: n.metadata.revision,
                })),
              },
            });
          } else {
            activity = f.view.activities.find(
              (a) => a.id === choice.activityId,
            );
            if (
              !activity ||
              ["paused", "completed", "abandoned", "failed"].includes(
                activity.state,
              )
            )
              throw new Error("activity-not-selectable");
          }
          if (choice.action === "abandon") {
            await access.change({
              agentId,
              operationId: `${atom.informationId}:abandon`,
              expectedRevision: activity.revision,
              activityId: activity.id,
              change: { state: "abandoned", reason: choice.reason },
              basis: [result.terminalInformationId],
            });
            reason = choice.reason;
            status = "completed";
            return;
          }
          await access.internalSource({
            operationId: `${atom.informationId}:choice`,
            source: {
              agentId,
              ownerId: "self:kaguya",
              scope,
              type: "internal-choice",
              text: `${choice.reason}。选择：${choice.action}。下一步：${choice.nextStep}`,
              basis: [result.terminalInformationId],
              occurredAt: atom.occurredAt,
            },
          });
          activity = await access.change({
            agentId,
            operationId: `${atom.informationId}:start`,
            expectedRevision: activity.revision,
            activityId: activity.id,
            change: {
              state: "active",
              reason: choice.reason,
              reevaluationRequired: false,
            },
            basis: [result.terminalInformationId],
          });
          const execution = await freeze(
            atom,
            scope,
            "execution-input",
            context,
            activity.id,
          );
          const memory = execution.atom.payload.memory as any;
          const source = execution.atom.payload.source as any;
          const observation = await context
            .use(observationCapability)
            .freezeNext({
              consumerId: "agent.continuity",
              policyVersion: "continuity.v1",
              address: source,
              kinds: [continuityExecutionFrozenKind.kind],
              resultKind: continuityCycleKind.kind,
              operationKey: execution.informationId,
              throughInformationId: execution.informationId,
              limit: 1000,
              manifest: {
                version: 1,
                proofKind: "continuity",
                runInformationId: execution.informationId,
                frozenInformationId: execution.informationId,
                sourceInformationIds: [execution.informationId],
                knowledgeCutoff: {
                  informationId: execution.informationId,
                  ...(memory.cutoff
                    ? {
                        memoryPublicationPosition:
                          memory.cutoff.publicationPosition,
                      }
                    : {}),
                  memoryRevisions: [
                    ...memory.fixed,
                    ...memory.recalled.map((r: any) => r.node),
                    ...(memory.personCandidates ?? []).map(
                      (p: any) => p.summary,
                    ),
                  ].map((n: any) => ({
                    id: n.id,
                    revision: n.metadata.revision,
                  })),
                },
                content: execution.atom.payload,
              },
            });
          if (!observation?.complete)
            throw new Error("incomplete-activity-observation");
          const run = await context.use(options.modelTaskCapability).execute({
            task: {
              taskId: "agent.continuity.execute",
              outputMode: "object",
              outputSchema: executionOutput,
              allowedTiers: ["heavy"],
            },
            activation,
            sourceInformationId: execution.informationId,
            contextInformationId: execution.view.contextInformationId,
            selectionPolicy: { tier: "heavy" },
            contextAtoms: [execution.atom],
            prompt: render([
              { name: "phase", content: "执行", informationIds: [] },
              {
                name: "context",
                content: JSON.stringify(execution.atom.payload),
                informationIds: [execution.informationId],
              },
            ]),
          });
          const savedReceipts = await access.receipts(
            agentId,
            scope,
            execution.informationId,
          );
          view = (await access.read(agentId, scope))!;
          activity = view.activities.find((a) => a.id === activity!.id)!;
          if (["abandoned", "paused"].includes(activity.state)) {
            reason = activity.state;
            return;
          }
          if (run.status !== "completed") {
            reason = `execution-${run.status}`;
            await access.change({
              agentId,
              operationId: `${atom.informationId}:result`,
              expectedRevision: activity.revision,
              activityId: activity.id,
              change: {
                state: "waiting",
                reason,
                externalResult: savedReceipts.some(
                  (r) => r.outcome.status === "partial",
                )
                  ? "partial"
                  : "unknown",
                nextStep: "核对原工具回执后继续，结果未知的写入不能重发",
              },
              basis: [
                run.terminalInformationId,
                ...savedReceipts.map((r) => r.receiptId),
              ],
            });
            await schedule(context, atom.informationId, view, 300000, scope);
            return;
          }
          const resourceReceipts = savedReceipts.map((r) => ({
            receiptId: r.receiptId,
            outcome: r.outcome,
          }));
          for (const receipt of savedReceipts) {
            if (
              receipt.intent.providerId !== "core.continuity" ||
              !["activity.inspect", "activity.reconcile"].includes(
                receipt.intent.toolName,
              ) ||
              receipt.outcome.status !== "succeeded"
            )
              continue;
            const observed = z
              .object({
                receipt: z.object({
                  receiptId: z.string().min(1),
                  outcome: actionOutcomeSchema,
                }),
              })
              .safeParse(receipt.outcome.result);
            if (observed.success) resourceReceipts.push(observed.data.receipt);
          }
          const output = executionOutput.parse(run.output);
          const resourceIds: string[] = [];
          const knownResources = (await access.read(agentId, scope))!.resources;
          const resourceByArtifact = new Map(
            knownResources.map((r) => [r.artifactId, r.id]),
          );
          for (const r of [...output.resources].sort(
            (a, b) =>
              Number(a.role === "verification") -
              Number(b.role === "verification"),
          )) {
            const receipt = resourceReceipts.find(
              (a) => a.receiptId === r.receiptId,
            );
            const artifact = receipt?.outcome.artifacts.find(
              (a) => a.id === r.artifactId,
            );
            if (!receipt || !artifact)
              throw new Error("resource-not-in-execution");
            const id = stableId(
              "activity-resource",
              `${r.receiptId}:${r.artifactId}:${r.role}`,
            );
            await access.resource({
              agentId,
              operationId: `resource:${id}`,
              resource: {
                id,
                scope,
                url: artifact.source,
                readAt: artifact.observedAt,
                contentHash: artifact.hash,
                actionReceiptId: r.receiptId,
                artifactId: artifact.id,
                role: r.role,
                verifies: r.verifies
                  ? (resourceByArtifact.get(r.verifies) ?? r.verifies)
                  : null,
              },
            });
            resourceIds.push(id);
            if (r.role === "note") resourceByArtifact.set(artifact.id, id);
          }
          const resources = (await access.read(agentId, scope))!.resources;
          const ownedResourceIds = new Set([
            ...activity.artifacts,
            ...resourceIds,
          ]);
          const verified = resources.some(
            (r) =>
              ownedResourceIds.has(r.id) &&
              r.role === "verification" &&
              resources.some(
                (n) =>
                  n.id === r.verifies &&
                  n.role === "note" &&
                  Date.parse(n.readAt) <= Date.parse(r.readAt) &&
                  resources.some(
                    (source) =>
                      ownedResourceIds.has(source.id) &&
                      source.role === "source" &&
                      Date.parse(source.readAt) <= Date.parse(n.readAt),
                  ),
              ),
          );
          const completed = output.status === "complete" && verified;
          const finished =
            completed &&
            (activity.kind !== "commitment" ||
              activity.fulfillment === "fulfilled");
          activity = await access.change({
            agentId,
            operationId: `${atom.informationId}:result`,
            expectedRevision: activity.revision,
            activityId: activity.id,
            change: {
              state: finished
                ? "completed"
                : output.status === "failed"
                  ? "failed"
                  : "waiting",
              reason: output.summary,
              nextStep: output.nextStep,
              completedSteps: output.completedSteps,
              artifacts: resourceIds,
              externalResult: completed
                ? "verified"
                : savedReceipts.some((r) => r.outcome.status === "partial")
                  ? "partial"
                  : "unknown",
              nextCheckAt: finished
                ? null
                : new Date(
                    context.now().getTime() + output.checkAfterMs,
                  ).toISOString(),
            },
            basis: [
              run.terminalInformationId,
              ...savedReceipts.map((r) => r.receiptId),
            ],
          });
          await access.internalSource({
            operationId: `${atom.informationId}:experience`,
            source: {
              agentId,
              ownerId: "self:kaguya",
              scope,
              type: "experience",
              text: `${activity.title}。宿主保存了 ${savedReceipts.length} 条工具回执和 ${resourceIds.length} 条资源引用。执行状态：${activity.state}。核对结果：${activity.externalResult}。模型说明（其文字不独立证明外部效果）：${output.summary}。下一步：${activity.nextStep}`,
              basis: [
                activity.informationId,
                ...savedReceipts.map((r) => r.receiptId),
              ],
              occurredAt: activity.updatedAt,
            },
          });
          status = completed ? "completed" : "waiting";
          reason = output.summary;
          await schedule(
            context,
            atom.informationId,
            (await access.read(agentId, scope))!,
            output.checkAfterMs,
            scope,
          );
        } catch (error) {
          if (
            context.signal.aborted ||
            (error instanceof Error &&
              error.message === "Model task execution could not be committed")
          ) {
            recoverable = true;
            throw error;
          }
          reason =
            error instanceof Error &&
            [
              "revision-conflict",
              "main-slot-busy",
              "activity-not-active",
              "autonomous-budget-exhausted",
            ].includes(error.message)
              ? error.message
              : "continuity-check-failed";
          status =
            reason === "autonomous-budget-exhausted"
              ? "waiting"
              : reason === "continuity-check-failed"
                ? "failed"
                : "superseded";
          if (status === "failed" && activity) {
            const current = (
              await access.read(agentId, scope)
            )?.activities.find((a) => a.id === activity!.id);
            if (current && current.state === "active")
              await access.change({
                agentId,
                operationId: `${atom.informationId}:failure`,
                activityId: current.id,
                expectedRevision: current.revision,
                change: {
                  state: "waiting",
                  reason,
                  nextStep: "核对已保存的调用和回执，再决定是否继续",
                  externalResult: "unknown",
                },
                basis: [atom.informationId],
              });
          }
          if (status === "failed" || reason === "autonomous-budget-exhausted")
            await schedule(
              context,
              atom.informationId,
              (await access.read(agentId, scope))!,
              300000,
              scope,
            );
        } finally {
          if (!recoverable && !context.signal.aborted) {
            const view = await access.read(agentId, scope);
            await context.commitTerminal(
              "agent.continuity.cycle",
              atom.informationId,
              continuityCycleKind,
              {
                ...(view
                  ? { contextInformationId: view.contextInformationId }
                  : {}),
                payload: {
                  sourceId: atom.informationId,
                  status,
                  reason,
                  activityId: activity?.id ?? null,
                },
                references: [
                  {
                    relation: "core:uses-context",
                    informationId: atom.informationId,
                  },
                ],
              },
            );
          }
        }
      };
      return {
        provisions: [
          { capability: continuityAppraisalCapability, value: { appraise } },
        ],
        ready: async (context) => {
          if (!context.use(nativeMemoryCapability).enabled)
            throw new Error("Continuity requires native Memory");
          const access = context.use(continuityCapability);
          const current = await access.read(agentId, settings.scope);
          const policy = {
            version: `continuity.v1:${settings.personaImportRevision}:${stableId("persona-content", options.identity.persona)}:${settings.subjectiveTtlMs}`,
            enabled: settings.autonomous,
            timeZone: options.identity.timeZone,
            dailyModelCalls: 24,
            subjectiveTtlMs: settings.subjectiveTtlMs,
          };
          if (
            !current ||
            (Object.keys(policy) as (keyof typeof policy)[]).some(
              (key) => current.policy[key] !== policy[key],
            )
          )
            await access.configure({
              agentId,
              operationId: `policy:${current?.revision ?? 0}:${policy.version}:${policy.enabled}`,
              expectedRevision: current?.revision ?? 0,
              policy,
              basis: [],
            });
          else if (policy.enabled)
            await context
              .use(lifecycleStartupCapability)
              .start(activation.instanceId);
        },
        subscriptions: [
          ...(options.deliveryDeliveredInformationKind
            ? [
                onInformation(
                  options.deliveryDeliveredInformationKind,
                  {
                    subscriptionId: "agent.continuity.delivery",
                    delivery: "durable",
                  },
                  async (atom, context) => {
                    const access = context.use(continuityCapability);
                    await access.observeDelivery({
                      agentId,
                      deliveryInformationId: atom.informationId,
                    });
                    if (
                      !atom.payload.target ||
                      typeof atom.payload.platform !== "string" ||
                      typeof atom.payload.adapterId !== "string"
                    )
                      return;
                    const scope = memoryScope({
                      platform: atom.payload.platform,
                      adapterId: atom.payload.adapterId,
                      destination: atom.payload.target as any,
                    });
                    const causes = new Set(
                      (await context.select(deliveryCauses)).map(
                        (a) => a.informationId,
                      ),
                    );
                    const view = await access.read(agentId, scope);
                    if (
                      view?.activities.some(
                        (a) =>
                          a.kind === "commitment" &&
                          a.state === "candidate" &&
                          a.acceptedBy &&
                          causes.has(a.acceptedBy),
                      )
                    )
                      await cycle(atom, context, scope);
                  },
                ),
              ]
            : []),
          onInformation(
            continuityActivityKind,
            {
              subscriptionId: "agent.continuity.activity-control",
              delivery: "durable",
            },
            async (atom, context) => {
              const activity = atom.payload.activity as unknown as Activity;
              if (
                activity.inFlight ||
                !(
                  (String(atom.payload.operationId ?? "").startsWith(
                    "control:",
                  ) &&
                    activity.state === "active") ||
                  String(atom.payload.operationId ?? "").startsWith(
                    "chat-resume:",
                  ) ||
                  (activity.reevaluationRequired &&
                    (typeof atom.payload.dependencyChange === "string" ||
                      atom.payload.boundary === "checkpoint" ||
                      atom.payload.boundary === "leave"))
                )
              )
                return;
              await cycle(atom, context, activity.scope);
            },
          ),
          onInformation(
            continuityInternalKind,
            { subscriptionId: "agent.continuity.memory", delivery: "durable" },
            async (atom, context) => {
              await publishInternalMemory(atom, context);
              if (atom.payload.type !== "persona-seed") return;
              await context.select(selected);
              const view = (await context
                .use(continuityCapability)
                .read(agentId, settings.scope))!;
              await context.registerOnce(
                "agent.continuity.self-ready",
                atom.informationId,
                selfReady,
                {
                  contextInformationId: view.contextInformationId,
                  payload: {
                    sourceId: atom.informationId,
                    scope: String(atom.payload.scope),
                  },
                  references: [
                    {
                      relation: "core:uses-context",
                      informationId: atom.informationId,
                    },
                  ],
                },
              );
            },
          ),
          onInformation(
            selfReady,
            {
              subscriptionId: "agent.continuity.self-ready",
              delivery: "durable",
              retryForever: true,
              retryDelayMs: 5000,
            },
            cycle,
          ),
          onInformation(
            continuityPolicyKind,
            {
              subscriptionId: "agent.continuity.policy",
              delivery: "durable",
              retryForever: true,
              retryDelayMs: 5000,
            },
            async (atom, context) => {
              const existing = await context
                .use(nativeMemoryCapability)
                .prepare({
                  scope: "shared",
                  owners: ["self:kaguya"],
                  asOf: context.now().toISOString(),
                  query: "",
                });
              if (
                !existing.fixed.some(
                  (n) =>
                    n.metadata.locked ||
                    n.metadata.tags.includes(
                      stableId("persona-content", options.identity.persona),
                    ),
                )
              ) {
                const source = {
                  agentId,
                  scope: "shared",
                  ownerId: "self:kaguya" as const,
                  type: "persona-seed" as const,
                  text: options.identity.persona,
                  basis: [atom.informationId],
                  occurredAt: atom.occurredAt,
                };
                await context.use(continuityCapability).internalSource({
                  operationId: `persona:${atom.informationId}`,
                  source,
                });
                return;
              }
              await cycle(atom, context);
            },
          ),
          onInformation(
            lifecycleStartedInformationKind,
            { subscriptionId: "agent.continuity.startup", delivery: "durable" },
            async (atom, context) => {
              if (atom.payload.instanceId === activation.instanceId)
                await cycle(atom, context);
            },
          ),
          onInformation(
            oneShotDueInformationKind,
            {
              subscriptionId: "agent.continuity.due",
              delivery: "durable",
              retryForever: true,
              retryDelayMs: 5000,
            },
            async (atom, context) => {
              const schedule = (await context.select(selected)).find(
                (a) => a.informationId === atom.payload.scheduleInformationId,
              );
              if (
                (schedule?.payload.input as any)?.consumer !==
                "agent.continuity"
              )
                return;
              await cycle(
                atom,
                context,
                String(
                  (schedule?.payload.input as any)?.scope ?? settings.scope,
                ),
              );
              await context.use(oneShotScheduleCapability).finish({
                scheduleInformationId: String(
                  atom.payload.scheduleInformationId,
                ),
                status: "fired",
              });
            },
          ),
        ],
      };
    },
  });
}
