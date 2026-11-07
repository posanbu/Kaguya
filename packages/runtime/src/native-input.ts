/**
 * assembleNativeInputWithArtifacts 先按元数据选择完整历史组，再只读取保留组的 blob；超预算开放组在读图前拒绝。
 * toolResults 接收与实时循环相同的归档投影；工具结果与关联图像保持在同一历史段中。
 * 功能概述：由冻结历史组装 provider 原生上下文；reasoning/图像与完整工具交互作为一组保留。
 * 工具调用只连接同一 completed 的持久结果，SDK 临时 tool-error 不构成执行证据。
 * 缺失配对时拒绝向新模型派发，裁剪不会留下孤立调用或结果。
 */
import {
  nativeResponseSchema,
  nativeMessagesSchema,
  type NativeMessage,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";

import type {
  NativeToolResultPlan,
  NativeArtifactReader,
} from "./native-tool-results.js";

/** Keep each native response intact. No reasoning text is converted into user prose. */
interface NativeInputOptions {
  prompt: string;
  atoms: readonly DeepReadonly<InformationAtom>[];
  taskId: string;
  instanceId: string;
  model: { providerId: string; modelId: string; configurationDigest?: string };
  maxBytes: number;
  toolResults?: ReadonlyMap<string, NativeMessage[]>;
}
interface NativeSegment {
  messages: NativeMessage[];
  pinned: boolean;
  extraBytes: number;
  projection?: NativeToolResultPlan;
  projectionOffset: number;
}
function selectNativeSegments(
  input: NativeInputOptions & {
    toolPlans?: ReadonlyMap<string, NativeToolResultPlan>;
  },
) {
  let used = Buffer.byteLength(
    JSON.stringify([{ role: "user", content: input.prompt }]),
  );
  if (used > input.maxBytes)
    throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
  const segments: NativeSegment[] = [];
  for (const atom of input.atoms) {
    if (
      atom.kind !== "core.model.task.completed" ||
      atom.payload.taskId !== input.taskId
    )
      continue;
    const payload = atom.payload as any;
    if (payload.activation.instanceId !== input.instanceId) continue;
    const native = nativeResponseSchema.safeParse(payload.native);
    if (!native.success) continue; // Legacy tasks have no native continuation.
    const source = input.atoms.find(
      (a) => a.informationId === payload.sourceInformationId,
    );
    const candidateId = (source?.payload.turn as any)?.candidateInformationId;
    const terminal = input.atoms.find(
      (a) =>
        a.payload.candidateInformationId === candidateId &&
        [
          "agent.router.turn.completed",
          "agent.router.turn.silent",
          "agent.router.turn.waiting",
          "agent.router.turn.failed",
          "agent.router.turn.superseded",
          "agent.router.turn.interrupted",
        ].includes(a.kind),
    );
    if (
      !candidateId ||
      terminal?.kind.endsWith(".superseded") ||
      terminal?.kind.endsWith(".interrupted")
    )
      continue;
    const openCalls = new Set<string>();
    for (const message of native.data.messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        if (!part || typeof part !== "object" || Array.isArray(part)) continue;
        if (part.type === "tool-call") openCalls.add(String(part.toolCallId));
        if (part.type === "tool-result")
          openCalls.delete(String(part.toolCallId));
      }
    }
    const compatible =
      payload.resolvedModel.providerId === input.model.providerId &&
      payload.resolvedModel.modelId === input.model.modelId &&
      payload.resolvedModel.configurationDigest ===
        input.model.configurationDigest;
    const projection = input.toolPlans?.get(atom.informationId);
    const projectionOffset = native.data.messages.length;
    const toolResults = input.atoms.filter(
      (a) =>
        a.kind === "agent.heavy.tool.result.v1" &&
        a.payload.modelCompletedInformationId === atom.informationId,
    );
    if (payload.generationKind === "tool-calls") {
      const ordered = (payload.toolCalls ?? []).map((c: any) =>
        toolResults.find((a) => a.payload.toolCallId === c.toolCallId),
      );
      if (
        ordered.some((r: any) => !r) ||
        ordered.length !== openCalls.size ||
        new Set(ordered.map((r: any) => r?.payload.toolCallId)).size !==
          ordered.length
      )
        throw new Error("NATIVE_TOOL_INTERACTION_OPEN");
      const projected =
        input.toolResults?.get(atom.informationId) ?? projection?.messages;
      if (
        compatible &&
        !projected &&
        ordered.some((r: any) => r.payload.value?.result?.image)
      )
        throw new Error("NATIVE_TOOL_INTERACTION_OPEN");
      if (projected) native.data.messages.push(...projected);
      else
        native.data.messages.push(
          ...nativeMessagesSchema.parse([
            {
              role: "tool",
              content: ordered.map((r: any, i: number) => ({
                type: "tool-result",
                toolCallId: r.payload.toolCallId,
                toolName: payload.toolCalls[i].toolName,
                output: { type: "json", value: r.payload.value },
              })),
            },
          ]),
        );
      for (const r of ordered) openCalls.delete(String(r!.payload.toolCallId));
    }
    if (!compatible) {
      if (openCalls.size) throw new Error("NATIVE_TOOL_INTERACTION_OPEN");
      continue;
    }
    const delivery = input.atoms.find(
      (a) =>
        a.kind === "core.delivery.requested" &&
        (a.payload.speech as { completedInformationId?: string } | undefined)
          ?.completedInformationId === atom.informationId,
    );
    const silent =
      (payload.output as { action?: string } | undefined)?.action === "silent";
    const receipt = silent
      ? undefined
      : delivery
        ? input.atoms.find(
            (a) =>
              (a.kind === "core.delivery.delivered" ||
                a.kind === "core.delivery.failed") &&
              a.references.some(
                (r) =>
                  r.relation === "core:status-of" &&
                  r.informationId === delivery.informationId,
              ),
          )
        : input.atoms.find(
            (a) =>
              a.informationId ===
              terminal?.payload.deliveryTerminalInformationId,
          );
    const recall =
      (payload.output as { action?: string } | undefined)?.action === "recall";
    const recallRequest = input.atoms.find(
      (a) =>
        a.kind === "agent.heavy.recall.requested" &&
        a.references.some(
          (r) =>
            r.relation === "core:caused-by" &&
            r.informationId === atom.informationId,
        ),
    );
    const recallResult = input.atoms.find(
      (a) =>
        a.kind === "agent.heavy.recall.completed" &&
        a.references.some(
          (r) =>
            r.relation === "core:caused-by" &&
            r.informationId === recallRequest?.informationId,
        ),
    );
    const contextId = (
      source?.payload.turn as { contextInformationId?: string } | undefined
    )?.contextInformationId;
    const background = input.atoms.find(
      (a) =>
        a.kind === "agent.router.conversation.context.frozen" &&
        a.references.some(
          (r) =>
            r.relation === "core:uses-context" && r.informationId === contextId,
        ),
    );
    const outcome: NativeMessage = {
      role: "user",
      content: JSON.stringify({
        actionRecord: atom.informationId,
        occurredAt: atom.occurredAt,
        source: source?.payload.target ?? source?.payload.source ?? null,
        conversation: background?.payload.background ?? null,
        evidenceRole: "historical-assistant-output-not-current-activity",
        status:
          payload.generationKind === "tool-calls"
            ? "native-tool-results"
            : recall
              ? recallResult
                ? `recall-${recallResult.payload.status}`
                : "recall-pending"
              : silent
                ? "agent.heavy.response.silent"
                : (receipt?.kind ?? terminal?.kind ?? "pending"),
        ...(recall
          ? { recall: recallResult?.payload.snapshot ?? null }
          : receipt
            ? { receipt: receipt.payload }
            : {}),
      }),
    };
    segments.push({
      ...(projection ? { projection } : {}),
      projectionOffset,
      extraBytes: projection
        ? projection.byteLength -
          Buffer.byteLength(JSON.stringify(projection.messages))
        : 0,
      messages: [...native.data.messages, outcome],
      pinned: recall
        ? !recallResult
        : !terminal ||
          terminal.kind.endsWith(".waiting") ||
          receipt?.payload.outcome === "unknown" ||
          openCalls.size > 0,
    });
  }
  // Reserve open interactions first, then admit complete recent segments.
  const retained = new Set<number>();
  for (const [index, segment] of segments.entries()) {
    if (!segment.pinned) continue;
    used +=
      Buffer.byteLength(JSON.stringify(segment.messages)) + segment.extraBytes;
    retained.add(index);
  }
  if (used > input.maxBytes)
    throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (retained.has(i)) continue;
    const size =
      Buffer.byteLength(JSON.stringify(segments[i]!.messages)) +
      segments[i]!.extraBytes;
    if (used + size <= input.maxBytes) {
      retained.add(i);
      used += size;
    }
  }
  return segments.filter((_, index) => retained.has(index));
}
function finishNativeInput(
  input: NativeInputOptions,
  messages: NativeMessage[],
): NativeMessage[] {
  messages.push({ role: "user", content: input.prompt });
  if (Buffer.byteLength(JSON.stringify(messages)) > input.maxBytes)
    throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
  return messages;
}
export function assembleNativeInput(
  input: NativeInputOptions,
): NativeMessage[] {
  return finishNativeInput(
    input,
    selectNativeSegments(input).flatMap((s) => s.messages),
  );
}
/** 先选择完整历史组，再读取其 blob；被裁掉的闭合图片不影响新请求，也不会触发读取。 */
export async function assembleNativeInputWithArtifacts(
  input: NativeInputOptions & {
    toolPlans: ReadonlyMap<string, NativeToolResultPlan>;
    readArtifact?: NativeArtifactReader;
  },
): Promise<NativeMessage[]> {
  const segments = selectNativeSegments(input);
  const messages: NativeMessage[] = [];
  for (const segment of segments) {
    const content = [...segment.messages];
    if (segment.projection)
      content.splice(
        segment.projectionOffset,
        segment.projection.messages.length,
        ...(await segment.projection.materialize(
          input.readArtifact,
          input.maxBytes,
        )),
      );
    messages.push(...content);
  }
  return finishNativeInput(input, messages);
}
