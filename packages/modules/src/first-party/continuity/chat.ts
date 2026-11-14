/** 先保存明确接受或延后的约定，再允许 Heavy 发送相应回答。 */
import {
  continuityChatDecisionSchema,
  nativeMemorySnapshotSchema,
  type InformationAtom,
  type DeepReadonly,
} from "@kaguya/schema";
import {
  continuityCapability,
  type InformationModuleHandlerContext,
} from "@kaguya/sdk";
import { nativeMemoryCapability, memoryScope } from "@kaguya/memory";
import { stableId } from "../memory-native/formation.js";

export async function recordChatChoice(
  value: unknown,
  completed: DeepReadonly<InformationAtom>,
  atoms: readonly DeepReadonly<InformationAtom>[],
  context: InformationModuleHandlerContext,
) {
  const choice = continuityChatDecisionSchema.parse(value);
  if (choice.kind === "none") return;
  const access = context.use(continuityCapability);
  const intent = atoms.find(
    (a) => a.kind === "agent.router.message.intent.requested",
  );
  const target = intent?.payload.target as any;
  if (!target) throw new Error("commitment-target-missing");
  const scope = memoryScope(target);
  const current = await access.read("kaguya", scope);
  if (!current) throw new Error("continuity-not-configured");
  if (choice.kind === "feedback") {
    if (!choice.activityId || !choice.requestId || !choice.outcome)
      throw new Error("feedback-choice-incomplete");
    await access.feedback({
      agentId: "kaguya",
      activityId: choice.activityId,
      feedbackInformationId: choice.requestId,
      completedInformationId: completed.informationId,
      outcome: choice.outcome,
    });
    return;
  }
  if (choice.kind === "deliver") {
    if (!choice.activityId) throw new Error("delivery-activity-missing");
    await access.planDelivery({
      agentId: "kaguya",
      operationId: `chat-delivery:${completed.informationId}`,
      activityId: choice.activityId,
      scope,
      completedInformationId: completed.informationId,
    });
    return;
  }
  const request = atoms.find(
    (a) =>
      a.kind === "core.message.inbound.text" &&
      a.informationId === choice.requestId,
  );
  const source = request?.payload.source as any;
  if (!request || !source) throw new Error("commitment-request-missing");
  if (memoryScope(source) !== scope)
    throw new Error("commitment-request-scope-mismatch");
  if (source.senderId === source.selfId || source.sender?.isSelf)
    throw new Error("commitment-request-not-human");
  if (!choice.title.trim() || !choice.goal.trim())
    throw new Error("commitment-goal-missing");
  if (current.activities.some((a) => a.acceptedFrom === request.informationId))
    return;
  const bindings = await context.use(nativeMemoryCapability).people({
    platform: source.platform,
    adapterId: source.adapterId,
    accountIds: [source.senderId],
  });
  const personIds = [...new Set(bindings.map((b) => b.ownerId))];
  const situation = atoms.find((a) => a.kind === "agent.situation.frozen");
  const frame = situation?.payload.frame as any;
  const memory = frame?.memory
    ? nativeMemorySnapshotSchema.parse(frame.memory)
    : undefined;
  await access.create({
    agentId: "kaguya",
    operationId: `chat-commitment:${request.informationId}`,
    expectedRevision: current.revision,
    activity: {
      id: stableId("commitment", request.informationId),
      scope,
      kind: "commitment",
      title: choice.title,
      goal: choice.goal,
      nextStep: choice.nextStep,
      nextCheckAt: choice.dueAt,
      sources: [request.informationId, completed.informationId],
      acceptedBy: completed.informationId,
      acceptedFrom: request.informationId,
      personIds: personIds.length === 1 ? personIds : [],
      memoryDependencies: memory
        ? [...memory.fixed, ...memory.recalled.map((r) => r.node)].map((n) => ({
            id: n.id,
            revision: n.metadata.revision,
          }))
        : [],
    },
  });
}
