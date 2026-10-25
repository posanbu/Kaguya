import { describe, it, expect } from "vitest";
import {
  compiledPromptSchema,
  type NativeMemorySnapshot,
} from "@kaguya/schema";
import { atom, fixture, target } from "../heavy/test-fixtures.js";
import { appendNativeMemoryToPrompt } from "./prompt.js";
const snapshot: NativeMemorySnapshot = {
  version: 1,
  status: "enabled",
  frozenAt: "2026-10-21T00:00:00Z",
  scope: "one",
  owners: ["person:ada"],
  people: [],
  participants: [],
  fixed: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      content: "Ada 是长期合作伙伴。",
      metadata: {
        system: "native-v1",
        kind: "person",
        ownerId: "person:ada",
        scope: "one",
        level: 0,
        revision: 1,
        status: "active",
        locked: false,
        sourceIds: [],
        aliases: [],
        tags: [],
        occurredAt: "2026-10-20T00:00:00Z",
      },
    },
  ],
  recalled: [],
  degraded: [],
  budget: { dynamicCharacters: 0, omittedNodeIds: [] },
};
const prompt = compiledPromptSchema.parse({
  kind: "route",
  text: "是否回复当前消息",
  templateId: "test",
  templates: [{ name: "test", content: "custom" }],
  variables: [],
});
function frozen(memory: NativeMemorySnapshot) {
  return atom("frozen", "agent.situation.frozen", {
    turnInformationId: "turn",
    frame: { memory },
  });
}
describe("mandatory frozen Memory context", () => {
  it("injects an unrelated summary into custom templates and records the actual payload", () => {
    const result = appendNativeMemoryToPrompt(
      prompt,
      [frozen(snapshot)],
      "turn",
    );
    expect(result.text).toContain("Ada 是长期合作伙伴");
    expect(
      JSON.parse(result.variables[0]!.content).fixed[0].metadata.revision,
    ).toBe(1);
    expect(appendNativeMemoryToPrompt(result, [frozen(snapshot)], "turn")).toBe(
      result,
    );
  });
  it("removes dynamic material before fixed context without mutating the persisted frame", () => {
    const memory = {
      ...snapshot,
      recalled: [
        {
          node: {
            ...snapshot.fixed[0]!,
            id: "00000000-0000-4000-8000-000000000002",
            content: "可选".repeat(30000),
          },
          traces: [],
          truncated: false,
        },
      ],
    };
    const result = appendNativeMemoryToPrompt(prompt, [frozen(memory)], "turn");
    expect(JSON.parse(result.variables[0]!.content).recalled).toEqual([]);
    expect(result.text).toContain("Ada 是长期合作伙伴");
    expect(memory.recalled).toHaveLength(1);
  });
  it("reports assembly failure if fixed context alone cannot fit and keeps historical prompts readable", () => {
    const memory = {
      ...snapshot,
      fixed: [{ ...snapshot.fixed[0]!, content: "固定".repeat(30000) }],
    };
    expect(() =>
      appendNativeMemoryToPrompt(prompt, [frozen(memory)], "turn"),
    ).toThrow("MEMORY_FIXED_CONTEXT_BUDGET_EXCEEDED");
    expect(appendNativeMemoryToPrompt(prompt, [], "turn")).toBe(prompt);
  });
});

describe("final evidence projection", () => {
  const initial = JSON.stringify({
    version: 2,
    mode: "bootstrap",
    historyCount: 0,
    sourceReferenceCount: 0,
    memoryCount: 0,
    participants: [{ ownerId: "person:ada" }],
  });
  const withEvidence = {
    ...prompt,
    text: `证据：${initial}`,
    variables: [
      { name: "context_bootstrap", content: initial, informationIds: ["turn"] },
    ],
  };
  it("counts fixed context without a query, history or dynamic results", () => {
    const result = appendNativeMemoryToPrompt(
      withEvidence,
      [frozen(snapshot)],
      "turn",
    );
    const state = result.variables.find((v) => v.name === "context_bootstrap")!;
    expect(JSON.parse(state.content)).toMatchObject({
      mode: "contextual",
      memoryStatus: "enabled",
      memoryCount: 1,
      fixedMemoryCount: 1,
      recalledMemoryCount: 0,
      participants: [
        {
          ownerId: "person:ada",
          fixedNodeIds: [snapshot.fixed[0]!.id],
          recalledNodeIds: [],
        },
      ],
    });
    expect(result.text).toContain(state.content);
    expect(result.text).not.toContain(initial);
  });
  it("updates counts and associations after dynamic truncation", () => {
    const memory = {
      ...snapshot,
      recalled: [
        {
          node: { ...snapshot.fixed[0]!, content: "细节".repeat(30000) },
          traces: [],
          truncated: false,
        },
      ],
    };
    const result = appendNativeMemoryToPrompt(
      withEvidence,
      [frozen(memory)],
      "turn",
    );
    const state = result.variables.find((v) => v.name === "context_bootstrap")!;
    expect(JSON.parse(state.content)).toMatchObject({
      fixedMemoryCount: 1,
      recalledMemoryCount: 0,
    });
    expect(
      JSON.parse(
        result.variables.find((v) => v.name === "native_memory")!.content,
      ).budget.omittedNodeIds,
    ).toHaveLength(1);
    expect(result.text).toContain(state.content);
    expect(memory.recalled).toHaveLength(1);
  });
  it("keeps disabled distinct from an enabled empty graph", () => {
    for (const status of ["enabled", "disabled"] as const) {
      const result = appendNativeMemoryToPrompt(
        withEvidence,
        [frozen({ ...snapshot, status, fixed: [] })],
        "turn",
      );
      expect(
        JSON.parse(
          result.variables.find((v) => v.name === "context_bootstrap")!.content,
        ),
      ).toMatchObject({
        memoryStatus: status,
        memoryCount: 0,
        mode: "bootstrap",
      });
    }
  });
});

it("recounts history after removing the optional raw context", () => {
  const f = fixture(["你好"]);
  const history = atom("earlier", "core.message.inbound.text", {
    text: "此前聊过天文",
    source: {
      ...target,
      senderId: "sender-0",
      platformMessageId: "earlier-platform",
    },
  });
  const global = "此前聊过天文".repeat(10000);
  const raw = atom(f.raw.informationId, f.raw.kind, {
    ...f.raw.payload,
    global: { text: global, informationIds: [history.informationId] },
    currentScope: { text: "", informationIds: [] },
  });
  const initial = JSON.stringify({
    version: 2,
    historyCount: 1,
    sourceReferenceCount: 0,
    participants: [],
  });
  const result = appendNativeMemoryToPrompt(
    {
      ...prompt,
      text: initial + global,
      variables: [
        {
          name: "context_bootstrap",
          content: initial,
          informationIds: [f.turn.informationId],
        },
        {
          name: "global_context",
          content: global,
          informationIds: [raw.informationId],
        },
      ],
    },
    [
      f.turn,
      raw,
      history,
      atom("frozen", "agent.situation.frozen", {
        turnInformationId: f.turn.informationId,
        frame: { memory: snapshot },
      }),
    ],
    f.turn.informationId,
  );
  const state = result.variables.find((v) => v.name === "context_bootstrap")!;
  expect(JSON.parse(state.content)).toMatchObject({
    historyCount: 0,
    fixedMemoryCount: 1,
    memoryCount: 1,
    participants: [{ priorInboundCount: 0 }],
  });
  expect(result.text).toContain(state.content);
  expect(result.text).not.toContain(global);
  expect(state.informationIds).not.toContain(history.informationId);
});
