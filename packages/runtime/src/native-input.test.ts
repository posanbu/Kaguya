import { expect, it } from "vitest";
import type { InformationAtom, NativeMessage } from "@kaguya/schema";
import { assembleNativeInput } from "./native-input.js";

const model = { providerId: "fixture", modelId: "model" };
function segment(
  id: string,
  status = "silent",
  messages: NativeMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "服务返回",
          providerOptions: { fixture: { signature: "opaque" } },
        },
        { type: "text", text: '{"action":"silent"}' },
      ],
    },
  ],
) {
  return [
    {
      informationId: `${id}:result`,
      kind: "core.model.task.completed",
      payload: {
        taskId: "heavy",
        activation: { instanceId: "heavy.default" },
        resolvedModel: model,
        sourceInformationId: `${id}:intent`,
        native: { version: 1, messages, reasoning: [] },
      },
    },
    {
      informationId: `${id}:intent`,
      kind: "intent",
      payload: { turn: { candidateInformationId: id } },
    },
    ...(status === "pending"
      ? []
      : [
          {
            informationId: `${id}:terminal`,
            kind: `agent.router.turn.${status}`,
            payload: {
              candidateInformationId: id,
              deliveryTerminalInformationId: `${id}:receipt`,
            },
          },
        ]),
  ].map((atom) => ({
    ...atom,
    occurredAt: "2026-10-20T00:00:00.000Z",
    source: "test",
    references: [],
  })) as InformationAtom[];
}
const assemble = (
  atoms: InformationAtom[],
  maxBytes = 10000,
  resolvedModel = model,
) =>
  assembleNativeInput({
    prompt: "冻结情境",
    atoms,
    taskId: "heavy",
    instanceId: "heavy.default",
    model: resolvedModel,
    maxBytes,
  });
it("replays native silent output unchanged and keeps Light separate", () => {
  const atoms = segment("one");
  const output = assemble(atoms);
  expect(output[0]).toEqual(
    atoms[0]!.payload.native && (atoms[0]!.payload.native as any).messages[0],
  );
  expect(output.at(-1)).toEqual({ role: "user", content: "冻结情境" });
  (atoms[0]!.payload as any).taskId = "light";
  expect(assemble(atoms)).toHaveLength(1);
});
it.each(["superseded", "interrupted"])(
  "excludes %s late model output",
  (status) => {
    expect(assemble(segment("old", status))).toHaveLength(1);
  },
);
it("keeps complete tool pairs and opaque provider metadata", () => {
  const messages: NativeMessage[] = [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call",
          toolName: "lookup",
          input: {},
          providerOptions: { fixture: { data: "opaque" } },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "lookup",
          output: { type: "text", value: "done" },
        },
      ],
    },
  ];
  expect(assemble(segment("tool", "completed", messages)).slice(0, 2)).toEqual(
    messages,
  );
  expect(
    assemble(segment("tool", "completed", messages), 10000, {
      ...model,
      modelId: "other",
    }),
  ).toHaveLength(1);
  expect(() =>
    assemble(segment("tool", "pending", messages.slice(0, 1)), 10000, {
      ...model,
      modelId: "other",
    }),
  ).toThrow("NATIVE_TOOL_INTERACTION_OPEN");
});
it("reserves unknown and pending outcomes before trimming closed segments", () => {
  const unknown = segment("unknown", "failed");
  unknown.push({
    informationId: "unknown:receipt",
    kind: "core.delivery.failed",
    payload: { outcome: "unknown" },
    occurredAt: "2026-10-20T00:00:00.000Z",
    source: "test",
    references: [],
  });
  expect(() => assemble(unknown, 70)).toThrow(
    "SITUATION_CONTEXT_BUDGET_EXCEEDED",
  );
  expect(() => assemble(segment("pending", "pending"), 70)).toThrow(
    "SITUATION_CONTEXT_BUDGET_EXCEEDED",
  );
  expect(assemble(segment("closed"), 70)).toEqual([
    { role: "user", content: "冻结情境" },
  ]);
});
