/** 表情纯策略测试：验证 Unicode 组合字素完整性与冷却/间隔双门槛，不启动 I/O。 */
import { describe, it, expect } from "vitest";
import { emojiParts, stripEmoji, rateAllowed } from "./policy.js";
import { atom } from "../heavy/test-fixtures.js";
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
    atom(`burst-${i}`, "agent.heavy.message.prepared", { text: "文字" }),
  );
  expect(
    rateAllowed(history, Date.parse(history[0]!.occurredAt) + 1000, {
      minMessagesBetween: 8,
      cooldownSeconds: 600,
    }),
  ).toBe(false);
  expect(stripEmoji("© 2026 ™ ordinary")).toBe("© 2026 ™ ordinary");
});
