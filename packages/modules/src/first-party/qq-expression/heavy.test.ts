import { qqExpressionHistorySelector } from "./heavy.js";
/** Heavy 表情决策契约：冻结素材、来源校验、明确不选、重放及发送额度。 */
import { describe, expect, it } from "vitest";
import { z } from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import {
  heavySettingsSchema,
  messageResponseOutputSchema,
} from "../heavy/index.js";
import { atom, fixture, target } from "../heavy/test-fixtures.js";
import { messageIntentRequestedInformationKind } from "../information-kinds.js";
import {
  appendQqExpressionPrompt,
  qqExpressionCandidates,
  resolveQqExpression,
  withQqExpressionContext,
} from "./heavy.js";
import { collected, learned } from "./facts.js";
import { scopeKey } from "./policy.js";

function data() {
  const f = fixture(["哈哈又翻车了", "有点好笑"]);
  const intent = {
    ...f.intent,
    payload: messageIntentRequestedInformationKind.payloadSchema.parse(
      f.intent.payload,
    ),
  };
  const scope = scopeKey(target);
  const asset = atom(
    "asset",
    collected.kind,
    {
      scope,
      assetId: "face-14",
      expression: { kind: "face", id: "14" },
      sourceInformationId: f.messages[0]!.informationId,
    },
    [
      {
        relation: "core:uses-context",
        informationId: f.messages[0]!.informationId,
      },
    ],
  );
  const meaning = atom(
    "meaning",
    learned.kind,
    {
      scope,
      assetInformationId: asset.informationId,
      meaning: "好笑的无奈",
      usage: "友好自嘲",
      confidence: 0.95,
      evidenceIds: [f.messages[0]!.informationId],
      basis: "context-inference",
    },
    [
      {
        relation: "core:uses-context",
        informationId: f.messages[0]!.informationId,
      },
    ],
  );
  const atoms = [...f.atoms, asset, meaning];
  const settings = heavySettingsSchema.parse({
    qqExpressionsEnabled: true,
    qqExpressionMinMessagesBetween: 3,
  });
  const prompt = appendQqExpressionPrompt(
    {
      kind: "message",
      templateId: "test",
      text: "正文",
      templates: [],
      variables: [],
    },
    atoms,
    intent,
    settings,
    (variables) => ({
      kind: "message",
      templateId: "test",
      text: variables[0]!.content,
      templates: [],
      variables: [...variables],
    }),
  );
  const request = atom("request", "core.model.task.requested", {
    taskId: "agent.heavy.respond",
    sourceInformationId: intent.informationId,
    contextInformationIds: atoms.map((a) => a.informationId),
    prompt: prompt as never,
  });
  const history = Array.from({ length: 3 }, (_, i) =>
    atom(`plain-${i}`, "core.message.assistant.text", {
      text: "正常文字",
      source: target,
    }),
  );
  const frozen = [...atoms, request];
  const now = Date.parse("2026-09-09T00:20:00.000Z");
  return {
    ...f,
    intent,
    asset,
    meaning,
    atoms,
    settings,
    prompt,
    request,
    history,
    frozen,
    now,
  };
}

describe("Heavy QQ expressions", () => {
  it("supports explicit no-expression and a JSON-schema-compatible single Heavy result", () => {
    expect(
      messageResponseOutputSchema.parse({
        action: "message",
        text: "你好",
        expression: null,
      }),
    ).toEqual({ action: "message", text: "你好", expression: null });
    expect(
      messageResponseOutputSchema.parse({ action: "message", text: "你好" }),
    ).toEqual({ action: "message", text: "你好" });
    expect(
      messageResponseOutputSchema.safeParse({
        action: "silent",
        expression: "qq-expression-1",
      }).success,
    ).toBe(false);
    expect(() => z.toJSONSchema(messageResponseOutputSchema)).not.toThrow();
    const f = data();
    for (const ref of [undefined, null, "invented", "asset", "qq-expression-2"])
      expect(
        resolveQqExpression(
          ref,
          f.frozen,
          f.intent,
          f.settings,
          f.history,
          f.now,
        ),
      ).toBeUndefined();
  });
  it("resolves a frozen reference and retains human provenance without exposing platform IDs or asset bytes", () => {
    const f = data();
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        f.intent,
        f.settings,
        f.history,
        f.now,
      ),
    ).toEqual({ kind: "face", id: "14" });
    expect(f.prompt.variables[0]!.informationIds).toEqual([
      f.asset.informationId,
      f.meaning.informationId,
    ]);
    expect(f.prompt.text).toContain("好笑的无奈");
    expect(f.prompt.text).not.toContain("platform-");
    expect(f.prompt.text).not.toContain('"id":"14"');
  });
  it("does not decorate when disabled, missing candidates, outside the scope, or without reliable evidence", () => {
    const f = data();
    expect(heavySettingsSchema.parse({}).qqExpressionsEnabled).toBe(false);
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        f.intent,
        { ...f.settings, qqExpressionsEnabled: false },
        f.history,
        f.now,
      ),
    ).toBeUndefined();
    const cross = {
      ...f.intent,
      payload: {
        ...f.intent.payload,
        target: {
          ...target,
          destination: { kind: "group" as const, groupId: "elsewhere" },
        },
      },
    };
    expect(qqExpressionCandidates(f.atoms, cross, f.settings)).toEqual([]);
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        cross,
        f.settings,
        f.history,
        f.now,
      ),
    ).toBeUndefined();
    for (const atoms of [
      f.atoms.filter((a) => a !== f.asset),
      f.atoms.filter((a) => a !== f.messages[0]),
      f.atoms.map((a) =>
        a === f.meaning
          ? atom(
              "meaning",
              learned.kind,
              { ...f.meaning.payload, confidence: 0.4 },
              [...f.meaning.references],
            )
          : a,
      ),
    ]) {
      expect(qqExpressionCandidates(atoms, f.intent, f.settings)).toEqual([]);
    }
  });
  it("requires both interval and cooldown; replay retains its original candidate mapping", () => {
    const f = data();
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        f.intent,
        f.settings,
        [],
        f.now,
      ),
    ).toBeUndefined();
    const recent = atom("recent", "core.message.assistant.text", {
      text: "文字",
      expression: { kind: "face", id: "14" },
    });
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        f.intent,
        f.settings,
        [recent, ...f.history],
        f.now,
      ),
    ).toBeUndefined();
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        f.intent,
        f.settings,
        [...f.history, recent],
        Date.parse(recent.occurredAt) + 1000,
      ),
    ).toBeUndefined();
    const later = atom("later", learned.kind, {
      ...f.meaning.payload,
      confidence: 0,
    });
    expect(
      resolveQqExpression(
        "qq-expression-1",
        [...f.frozen, later],
        f.intent,
        f.settings,
        f.history,
        f.now,
      ),
    ).toEqual({ kind: "face", id: "14" });
    expect(
      resolveQqExpression(
        "qq-expression-1",
        f.frozen,
        f.intent,
        { ...f.settings, qqExpressionMinConfidence: 1 },
        f.history,
        f.now,
      ),
    ).toBeUndefined();
  });
  it("selects latest same-scope semantics and skips new queries when replaying a saved request", async () => {
    const f = data();
    let meanings = [f.meaning];
    let queries = 0;
    const ledger: InformationSelectorLedger = {
      find: async (q) => {
        queries++;
        if (q.kinds?.includes(learned.kind)) return meanings;
        return f.frozen.filter((a) =>
          q.informationIds?.includes(a.informationId),
        );
      },
      related: async (q) =>
        f.atoms.filter(
          (a) =>
            (q.from.includes(f.asset.informationId) ||
              q.from.includes(f.meaning.informationId)) &&
            a === f.messages[0],
        ),
      retrieve: async () => [],
    };
    const base = {
      selectorId: "test.base",
      select: () =>
        f.atoms
          .filter((a) => a !== f.meaning && a !== f.asset)
          .map((a) => a.informationId),
    };
    const selector = withQqExpressionContext(base);
    expect(await selector.select({ sourceAtom: f.intent, ledger })).toContain(
      f.asset.informationId,
    );
    const revoked = atom("revoked", learned.kind, {
      ...f.meaning.payload,
      confidence: 0,
    });
    meanings = [revoked, f.meaning];
    const ids = await selector.select({ sourceAtom: f.intent, ledger });
    expect(
      qqExpressionCandidates(
        f.frozen.filter((a) => ids.includes(a.informationId)),
        f.intent,
        f.settings,
      ),
    ).toEqual([]);
    queries = 0;
    const replay = withQqExpressionContext({
      ...base,
      select: () => f.frozen.map((a) => a.informationId),
    });
    expect(await replay.select({ sourceAtom: f.intent, ledger })).toEqual(
      f.frozen.map((a) => a.informationId),
    );
    expect(queries).toBe(1);
  });
});

it("does not renumber a frozen reference when a stricter confidence setting removes an earlier candidate", () => {
  const f = data();
  const asset = atom(
    "asset-2",
    collected.kind,
    {
      ...f.asset.payload,
      assetId: "face-15",
      expression: { kind: "face", id: "15" },
    },
    [...f.asset.references],
  );
  const meaning = atom(
    "meaning-2",
    learned.kind,
    {
      ...f.meaning.payload,
      assetInformationId: asset.informationId,
      confidence: 0.99,
    },
    [...f.meaning.references],
  );
  const atoms = [...f.atoms, asset, meaning];
  const prompt = appendQqExpressionPrompt(
    f.prompt,
    atoms,
    f.intent,
    f.settings,
    (variables) => ({
      kind: "message",
      templateId: "test",
      text: variables[0]!.content,
      templates: [],
      variables: [...variables],
    }),
  );
  // Only one candidate variable exists in an actual request.
  const frozenPrompt = { ...prompt, variables: [prompt.variables.at(-1)!] };
  const request = atom("request", f.request.kind, {
    ...f.request.payload,
    prompt: frozenPrompt as never,
    contextInformationIds: atoms.map((a) => a.informationId),
  });
  const settings = { ...f.settings, qqExpressionMinConfidence: 0.98 };
  expect(
    resolveQqExpression(
      "qq-expression-1",
      [...atoms, request],
      f.intent,
      settings,
      f.history,
      f.now,
    ),
  ).toBeUndefined();
  expect(
    resolveQqExpression(
      "qq-expression-2",
      [...atoms, request],
      f.intent,
      settings,
      f.history,
      f.now,
    ),
  ).toEqual({ kind: "face", id: "15" });
});

it("requires a visible enabled native Memory snapshot when a situation frame exists", () => {
  const f = data();
  const memory = {
    version: 1,
    status: "enabled",
    frozenAt: f.turn.occurredAt,
    scope: "scope",
    owners: ["expression:kaguya"],
    fixed: [],
    recalled: [],
    degraded: [],
    budget: { dynamicCharacters: 1000, omittedNodeIds: [] },
  };
  const frame = (m: Record<string, unknown>) =>
    atom("situation", "agent.situation.frozen", {
      turnInformationId: f.turn.informationId,
      frame: { memory: m as never },
    });
  expect(
    qqExpressionCandidates([...f.atoms, frame(memory)], f.intent, f.settings),
  ).toEqual([]);
  expect(
    qqExpressionCandidates(
      [...f.atoms, frame({ ...memory, status: "disabled" })],
      f.intent,
      f.settings,
    ),
  ).toEqual([]);
  const node = {
    id: "00000000-0000-4000-8000-000000000001",
    content: "管理员核实的素材用法",
    metadata: {
      occurredAt: f.turn.occurredAt,
      system: "native-v1",
      kind: "expression",
      ownerId: "expression:kaguya",
      scope: "scope",
      level: 1,
      revision: 2,
      status: "active",
      locked: true,
      sourceIds: [f.messages[0]!.informationId],
      qqAssetId: f.asset.informationId,
      confidence: 0.99,
    },
  };
  expect(
    qqExpressionCandidates(
      [...f.atoms, frame({ ...memory, fixed: [node] })],
      f.intent,
      f.settings,
    )[0]?.description.meaning,
  ).toBe(node.content);
});
it("counts pending speech-ready reservations once and resolves the root intent for continuation and recall", async () => {
  const f = data();
  const step = atom("step", "agent.heavy.step.requested", {
    intentInformationId: f.intent.informationId,
  });
  const completed = atom("result", "core.model.task.completed", {});
  const speech = { completedInformationId: "prior-completion" };
  const ready = atom("ready", "agent.heavy.message.ready", {
    text: "先说一句",
    expression: { kind: "face", id: "14" },
    speech,
  });
  const assistant = atom(
    "sent",
    "core.message.assistant.text",
    JSON.parse(JSON.stringify(ready.payload)),
  );
  const pending = atom("pending", "agent.heavy.message.ready", {
    text: "尚未发送",
    speech: { completedInformationId: "next-completion" },
  });
  const ledger: InformationSelectorLedger = {
    find: async (q) =>
      q.kinds?.includes("core.message.assistant.text")
        ? [assistant, ready, pending]
        : [f.intent],
    related: async (q) =>
      q.from.includes(completed.informationId) ? [f.request] : [step],
    retrieve: async () => [],
  };
  expect(
    await qqExpressionHistorySelector.select({ sourceAtom: completed, ledger }),
  ).toEqual([assistant.informationId, pending.informationId]);
});
