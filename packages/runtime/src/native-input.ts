import {
  nativeResponseSchema,
  type NativeMessage,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";

/** Keep each native response intact. No reasoning text is converted into user prose. */
export function assembleNativeInput(input: {
  prompt: string;
  atoms: readonly DeepReadonly<InformationAtom>[];
  taskId: string;
  instanceId: string;
  model: { providerId: string; modelId: string };
  maxBytes: number;
}): NativeMessage[] {
  const messages: NativeMessage[] = [];
  let used = Buffer.byteLength(
    JSON.stringify([{ role: "user", content: input.prompt }]),
  );
  if (used > input.maxBytes)
    throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
  const segments: { messages: NativeMessage[]; pinned: boolean }[] = [];
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
      payload.resolvedModel.modelId === input.model.modelId;
    if (!compatible) {
      if (openCalls.size) throw new Error("NATIVE_TOOL_INTERACTION_OPEN");
      continue;
    }
    const receiptId = terminal?.payload.deliveryTerminalInformationId;
    const receipt = input.atoms.find((a) => a.informationId === receiptId);
    const outcome: NativeMessage = {
      role: "user",
      content: JSON.stringify({
        actionRecord: atom.informationId,
        status: terminal?.kind ?? "pending",
        ...(receipt ? { receipt: receipt.payload } : {}),
      }),
    };
    segments.push({
      messages: [...native.data.messages, outcome],
      pinned:
        !terminal ||
        terminal.kind.endsWith(".waiting") ||
        receipt?.payload.outcome === "unknown" ||
        openCalls.size > 0,
    });
  }
  // Reserve open interactions first, then admit complete recent segments.
  const retained = new Set<number>();
  for (const [index, segment] of segments.entries()) {
    if (!segment.pinned) continue;
    used += Buffer.byteLength(JSON.stringify(segment.messages));
    retained.add(index);
  }
  if (used > input.maxBytes)
    throw new Error("SITUATION_CONTEXT_BUDGET_EXCEEDED");
  for (let i = segments.length - 1; i >= 0; i--) {
    if (retained.has(i)) continue;
    const size = Buffer.byteLength(JSON.stringify(segments[i]!.messages));
    if (used + size <= input.maxBytes) {
      retained.add(i);
      used += size;
    }
  }
  for (const [index, segment] of segments.entries())
    if (retained.has(index)) messages.push(...segment.messages);
  messages.push({ role: "user", content: input.prompt });
  return messages;
}
