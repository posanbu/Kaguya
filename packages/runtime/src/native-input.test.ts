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

it("replays each part with its own actual receipt within a shared turn", () => {
  const atoms = segment("speech", "failed");
  const first = atoms[0]!;
  atoms.push({ ...first, informationId: "speech:second" });
  for (const [index, result] of [first, atoms.at(-1)!].entries()) {
    const deliveryId = `delivery:${index}`;
    atoms.push({
      ...first,
      informationId: deliveryId,
      kind: "core.delivery.requested",
      payload: { speech: { completedInformationId: result.informationId } },
    });
    atoms.push({
      ...first,
      informationId: `receipt:${index}`,
      kind: index === 0 ? "core.delivery.delivered" : "core.delivery.failed",
      payload: { outcome: index === 0 ? "delivered" : "unknown" },
      references: [{ relation: "core:status-of", informationId: deliveryId }],
    });
  }
  const actions = assemble(atoms)
    .filter(
      (m) =>
        m.role === "user" &&
        typeof m.content === "string" &&
        m.content.startsWith("{"),
    )
    .map((m) => JSON.parse(String(m.content)));
  expect(actions).toEqual([
    expect.objectContaining({
      actionRecord: "speech:result",
      status: "core.delivery.delivered",
      receipt: { outcome: "delivered" },
    }),
    expect.objectContaining({
      actionRecord: "speech:second",
      status: "core.delivery.failed",
      receipt: { outcome: "unknown" },
    }),
  ]);
});

it("does not assign a previous delivery to a silent continuation", () => {
  const atoms = segment("silent-step", "completed");
  atoms[0] = {
    ...atoms[0]!,
    payload: { ...atoms[0]!.payload, output: { action: "silent" } },
  };
  atoms.push({
    ...atoms[0]!,
    informationId: "silent-step:receipt",
    kind: "core.delivery.delivered",
    payload: { outcome: "delivered" },
  });
  expect(JSON.parse(String(assemble(atoms)[1]!.content))).toMatchObject({
    actionRecord: "silent-step:result",
    status: "agent.heavy.response.silent",
  });
});

it("keeps historical assistant time and verified conversation source separate from current activity", () => {
  const atoms = segment("morning");
  atoms[0]!.occurredAt = "2026-10-22T03:04:00.000Z";
  atoms[1]!.payload = {
    target: {
      adapterId: "qq",
      platform: "qq",
      destination: { kind: "group", groupId: "210794534" },
    },
    turn: {
      candidateInformationId: "morning",
      contextInformationId: "morning-context",
    },
  };
  atoms.push({
    informationId: "source",
    kind: "agent.router.conversation.context.frozen",
    occurredAt: atoms[0]!.occurredAt,
    source: "test",
    payload: { background: { name: "菅弦乐团教务处" } },
    references: [
      { relation: "core:uses-context", informationId: "morning-context" },
    ],
  });
  const outcome = JSON.parse(String(assemble(atoms).at(-2)!.content));
  expect(outcome).toMatchObject({
    occurredAt: "2026-10-22T03:04:00.000Z",
    conversation: { name: "菅弦乐团教务处" },
    evidenceRole: "historical-assistant-output-not-current-activity",
  });
});
