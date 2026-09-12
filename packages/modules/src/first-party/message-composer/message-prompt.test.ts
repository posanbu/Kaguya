/**
 * 功能概述：验证消息编写 Prompt 的整轮语义、冻结快照权威性和辅助上下文预算。
 * 超长历史和 Memory 用例同时检查 Unicode 完整性、预算上限及实际保留内容的 provenance。
 * 主要职责：保护全部输入同等渲染、逐条引用、模板溯源、缺失 turn 拒绝以及 target-only assistant 历史，防止 Memory 跨作用域引用泄漏。
 * 代码库关系：使用真实默认模板、information-kinds 与 message-prompt，不模拟编译结果。
 * 输入输出与副作用：仅冻结内存原子，无网络或模型调用。
 */
import { describe, expect, it } from "vitest";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import {
  assistantTextInformationKind,
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  messageIntentRequestedInformationPayloadSchema,
} from "../information-kinds.js";
import {
  compileMessagePrompt,
  fitHistoryBudget,
  fitMemoryBudget,
  ZH_CN_MESSAGE_PROMPT,
} from "./message-prompt.js";
import { atom, fixture, identity, target } from "./test-fixtures.js";
const templates = loadFirstPartyPromptTemplates().messageComposer;
describe("message prompt", () => {
  it("compiles every frozen input equally with per-input quotes and provenance", () => {
    const f = fixture();
    const result = compileMessagePrompt(
      templates,
      identity,
      f.atoms,
      f.intent.informationId,
    );
    expect(result.kind).toBe("message");
    expect(result.text).toContain("FIRST_INPUT");
    expect(result.text).toContain("账号 bot-1");
    expect(result.text).toContain("LAST_INPUT");
    expect(result.text).toContain("引用消息 ID：platform-0");
    expect(result.text).toContain("【入站引用参考】");
    expect(result.text).not.toContain("LEGACY_LAST_BODY");
    expect(result.text).not.toContain("【目标消息】");
    expect(
      result.variables.find((v) => v.name === "turn")?.informationIds,
    ).toEqual(f.messages.map((m) => m.informationId));
    expect(result.variables.some((v) => v.name === "target")).toBe(false);
    expect(result.text.indexOf("sender-0")).toBeLessThan(
      result.text.indexOf("sender-1"),
    );
    expect(result.templates.some((t) => t.name === "turn")).toBe(true);
  });
  it("does not drop or truncate frozen inputs beyond the historical budgets", () => {
    const texts = Array.from(
      { length: 35 },
      (_, i) => `INPUT_${i}_` + "🌙".repeat(500),
    );
    const f = fixture(texts);
    const result = compileMessagePrompt(
      templates,
      identity,
      f.atoms,
      f.intent.informationId,
    );
    for (const text of texts) expect(result.text).toContain(text);
    expect(
      result.variables.find((v) => v.name === "turn")?.informationIds,
    ).toHaveLength(35);
    expect(fitHistoryBudget(f.messages)).toHaveLength(24);
    expect(ZH_CN_MESSAGE_PROMPT.historyMessageLimit).toBe(30);
  });
  it("requires matching turn provenance and target, never falls back to intent text", () => {
    const f = fixture();
    expect(() =>
      compileMessagePrompt(
        templates,
        identity,
        [f.intent],
        f.intent.informationId,
      ),
    ).toThrow("frozen turn");
    const intent = messageIntentRequestedInformationPayloadSchema.parse(
      f.intent.payload,
    );
    const wrong = atom("intent-1", f.intent.kind, {
      ...intent,
      turn: { ...intent.turn, claimInformationId: "wrong" },
    });
    expect(() =>
      compileMessagePrompt(
        templates,
        identity,
        [wrong, f.turn],
        wrong.informationId,
      ),
    ).toThrow("provenance");
    const scoped = atom("intent-1", f.intent.kind, {
      ...intent,
      target: { ...target, adapterId: "other" },
    });
    expect(() =>
      compileMessagePrompt(
        templates,
        identity,
        [scoped, f.turn],
        scoped.informationId,
      ),
    ).toThrow("target");
  });
  it("renders assistant history with target-only source metadata", () => {
    const f = fixture();
    const previous = atom("assistant-1", assistantTextInformationKind.kind, {
      text: "EARLIER_ASSISTANT",
      source: target,
      originatingModuleInstanceId: "composer-1",
      turn: null,
    });
    const result = compileMessagePrompt(
      templates,
      identity,
      [...f.atoms, previous],
      f.intent.informationId,
    );
    expect(result.text).toContain("Kaguya：EARLIER_ASSISTANT");
  });
  it("supports turn layout overrides without introducing a last-message target", () => {
    const f = fixture(["A", "B"]);
    const result = compileMessagePrompt(
      {
        ...templates,
        main: "{{name}}/{{name}}:{{turn}}",
        turn: "{{#each messages}}[{{content}}]{{/each}}",
      },
      identity,
      f.atoms,
      f.intent.informationId,
    );
    expect(result.text).toBe("Kaguya/Kaguya:[A][B]");
    expect(result.variables.map((v) => v.name)).toEqual(["name", "turn"]);
  });
});

it("rejects the removed outer quoted variable during template compilation", () => {
  const f = fixture();
  expect(() =>
    compileMessagePrompt(
      { ...templates, main: "{{quoted}}" },
      identity,
      f.atoms,
      f.intent.informationId,
    ),
  ).toThrow();
});

it("keeps and Unicode-truncates an oversized newest historical message", () => {
  const f = fixture();
  const source = {
    ...target,
    senderId: "history-user",
    platformMessageId: "history-message",
  };
  const older = atom("history-a", inboundTextInformationKind.kind, {
    text: "OLDER_HISTORY",
    source,
  });
  const newest = atom("history-z", inboundTextInformationKind.kind, {
    text: "🌙".repeat(ZH_CN_MESSAGE_PROMPT.historyCharacterLimit + 100),
    source,
  });
  const kept = fitHistoryBudget([newest, older]);
  expect(kept.map((entry) => entry.informationId)).toEqual([
    newest.informationId,
  ]);
  const result = compileMessagePrompt(
    templates,
    identity,
    [...f.atoms, ...kept],
    f.intent.informationId,
  );
  const history = result.variables.find((entry) => entry.name === "history")!;
  expect(history.informationIds).toEqual([newest.informationId]);
  expect(history.content).toContain("🌙🌙");
  expect(history.content).toContain("…");
  expect(history.content.isWellFormed()).toBe(true);
  expect(Array.from(history.content).length).toBeLessThanOrEqual(
    ZH_CN_MESSAGE_PROMPT.historyCharacterLimit + 32,
  );
  expect(history.content).not.toContain("OLDER_HISTORY");
  expect(result.text).toContain("FIRST_INPUT");
  expect(result.text).toContain("LAST_INPUT");
});

it("bounds Memory by Unicode code points and records only rendered memory provenance", () => {
  const f = fixture();
  const first = atom("memory-1", coreMemoryTextInformationKind.kind, {
    text: "🌙".repeat(ZH_CN_MESSAGE_PROMPT.memoryCharacterLimit + 100),
  });
  const later = atom("memory-2", coreMemoryTextInformationKind.kind, {
    text: "LATER_MEMORY_MUST_NOT_APPEAR",
  });
  expect(
    fitMemoryBudget([first, later]).map((entry) => entry.informationId),
  ).toEqual([first.informationId]);
  const intent = atom(f.intent.informationId, f.intent.kind, {
    ...messageIntentRequestedInformationPayloadSchema.parse(f.intent.payload),
    memoryInformationIds: [first.informationId, later.informationId],
  });
  const result = compileMessagePrompt(
    templates,
    identity,
    [intent, f.turn, ...f.messages, first, later],
    intent.informationId,
  );
  const memory = result.variables.find((entry) => entry.name === "memory")!;
  expect(memory.informationIds).toEqual([first.informationId]);
  expect(memory.content).toContain("🌙🌙");
  expect(memory.content).toContain("…");
  expect(memory.content.isWellFormed()).toBe(true);
  expect(Array.from(memory.content).length).toBeLessThanOrEqual(
    ZH_CN_MESSAGE_PROMPT.memoryCharacterLimit + 32,
  );
  expect(memory.content).not.toContain("LATER_MEMORY_MUST_NOT_APPEAR");
});

it("does not quote a memory-authorized inbound message from another target with a colliding platform ID", () => {
  const f = fixture();
  const memory = atom("foreign-memory", inboundTextInformationKind.kind, {
    text: "FOREIGN_MEMORY",
    source: {
      ...target,
      adapterId: "foreign-adapter",
      senderId: "foreign-user",
      platformMessageId: "platform-0",
    },
  });
  const intent = atom(f.intent.informationId, f.intent.kind, {
    ...messageIntentRequestedInformationPayloadSchema.parse(f.intent.payload),
    memoryInformationIds: [memory.informationId],
  });
  const result = compileMessagePrompt(
    templates,
    identity,
    [intent, f.turn, ...f.messages, memory],
    intent.informationId,
  );
  const turn = result.variables.find((entry) => entry.name === "turn")!;
  expect(turn.content).not.toContain("FOREIGN_MEMORY");
  expect(turn.content).toContain("FIRST_INPUT");
  expect(turn.content).toContain("【入站引用参考】");
  expect(turn.informationIds).not.toContain(memory.informationId);
});
