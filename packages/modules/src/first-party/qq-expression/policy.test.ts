/** 表情纯策略测试：验证 Unicode 组合字素完整性与冷却/间隔双门槛，不启动 I/O。 */
import { describe, it, expect } from "vitest";
import { emojiParts, stripEmoji, rateAllowed } from "./policy.js";
import type { JsonObject } from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";
import { createQqExpressionModule } from "./index.js";
import { modelToken } from "../test-support/cognitive-fixture.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { atom, fixture, target } from "../message-composer/test-fixtures.js";
describe("emoji and expression limits", () => {
  it.each(["😂", "👍🏽", "👨‍👩‍👧‍👦", "🇨🇳", "1️⃣"])("keeps %s as one glyph", (glyph) => {
    expect(emojiParts(glyph)).toEqual([glyph]);
    expect(stripEmoji(`普通文字${glyph}结束`)).toBe("普通文字结束");
  });
  it("requires both ordinary replies and cooldown and limits the first use", () => {
    const ordinary = Array.from({ length: 8 }, (_, i) =>
      atom(`plain-${i}`, "core.message.assistant.text", { text: "普通回复" }),
    );
    const previous = atom("emoji", "core.message.assistant.text", {
      text: "😂",
    });
    const settings = { minMessagesBetween: 8, cooldownSeconds: 600 };
    const time = Date.parse(previous.occurredAt);
    expect(rateAllowed(ordinary.slice(0, 7), time + 600000, settings)).toBe(
      false,
    );
    expect(rateAllowed(ordinary, time, settings)).toBe(true);
    expect(rateAllowed([...ordinary, previous], time + 599999, settings)).toBe(
      false,
    );
    expect(
      rateAllowed([...ordinary.slice(0, 7), previous], time + 600000, settings),
    ).toBe(false);
    expect(rateAllowed([...ordinary, previous], time + 600000, settings)).toBe(
      true,
    );
  });
});

it("does not reset cooldown when a busy conversation truncates recent history", () => {
  const history = Array.from({ length: 101 }, (_, i) =>
    atom(`burst-${i}`, "agent.message.prepared", { text: "文字" }),
  );
  expect(
    rateAllowed(history, Date.parse(history[0]!.occurredAt) + 1000, {
      minMessagesBetween: 8,
      cooldownSeconds: 600,
    }),
  ).toBe(false);
  expect(stripEmoji("© 2026 ™ ordinary")).toBe("© 2026 ™ ordinary");
});

it.each([
  [undefined, false],
  ["neutral", false],
  ["humorous", true],
  ["teasing", true],
] as const)(
  "allows expression context only for an explicit humorous plan (%s)",
  async (tone, allowed) => {
    const f = fixture();
    const intent = atom(
      f.intent.informationId,
      f.intent.kind,
      {
        ...f.intent.payload,
        composition: {
          ...(f.intent.payload.composition as JsonObject),
          ...(tone ? { tone } : {}),
        },
      },
      [...f.intent.references],
    );
    const request = atom("request", "core.model.task.requested", {}, [
      { relation: "core:caused-by", informationId: intent.informationId },
    ]);
    const result = atom("result", "core.model.task.completed", {}, [
      { relation: "core:caused-by", informationId: request.informationId },
    ]);
    const draft = atom(
      "draft",
      "agent.message.draft",
      {
        text: "普通正文",
        source: target,
        originatingModuleInstanceId: "composer",
        turn: intent.payload.turn as JsonObject,
      },
      [{ relation: "core:caused-by", informationId: result.informationId }],
    );
    const atoms = [intent, request, result, draft, f.turn, ...f.messages];
    const definition = createQqExpressionModule({
      modelTaskCapability: modelToken,
      templates: loadFirstPartyPromptTemplates().qqExpression,
    });
    const selector = definition.manifest.selectors.find(
      (s) => s.selectorId === "plugin.qq-expression.draft",
    )!;
    const ledger: InformationSelectorLedger = {
      find: async (q) =>
        atoms.filter((a) => q.informationIds?.includes(a.informationId)),
      related: async () => [],
      retrieve: async () => [],
    };
    const ids = await selector.select({ sourceAtom: draft, ledger });
    expect(ids.includes(f.turn.informationId)).toBe(allowed);
    const crossDraft = atom(
      "cross",
      draft.kind,
      {
        ...draft.payload,
        source: { ...target, destination: { kind: "group", groupId: "other" } },
      },
      [...draft.references],
    );
    expect(
      await selector.select({ sourceAtom: crossDraft, ledger }),
    ).not.toContain(f.turn.informationId);
  },
);
