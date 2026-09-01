/**
 * 架构说明：本测试守护信息原子契约的边界行为，覆盖 JSON 负载校验与
 * 深冻结快照语义，确保 wire contract 不会把可变外部对象引用带进持久化层。
 * 代码库关系：`packages/schema/src/index.ts` 与下游包会消费这里定义的
 * `information*` 导出；这些断言必须独立于实现细节，直接描述公共 API。
 */
import { describe, expect, it } from "vitest";

import {
  parseInformationAtom,
  freezeInformationAtom,
  informationAtomSchema,
  informationIdSchema,
} from "./information.js";

describe("informationAtomSchema", () => {
  it("rejects non-object and non-JSON payloads", () => {
    expect(() =>
      informationAtomSchema.parse({
        informationId: "atom-1",
        kind: "acme.message.created",
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { value: 1n },
        references: [],
      }),
    ).toThrow();
  });
});

describe("freezeInformationAtom", () => {
  it("returns a deeply frozen snapshot", () => {
    const payload = { nested: { values: ["moon"] } };
    const atom = freezeInformationAtom({
      informationId: informationIdSchema.parse("atom-1"),
      kind: "acme.message.created",
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload,
      references: [],
    });

    payload.nested.values[0] = "changed";

    expect(atom.payload).toEqual({ nested: { values: ["moon"] } });
    expect(Object.isFrozen(atom.payload.nested.values)).toBe(true);
  });
});

describe("parseInformationAtom", () => {
  it("returns a deeply frozen plain JSON payload", () => {
    const parsed = parseInformationAtom({
      informationId: "atom-2",
      kind: "acme.message.created",
      occurredAt: "2026-09-01T00:00:00.000Z",
      source: "module:acme",
      payload: { nested: { values: ["moon"] } },
      references: [],
    });

    expect(Object.getPrototypeOf(parsed.payload)).toBe(Object.prototype);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.payload)).toBe(true);
    expect(
      Object.isFrozen(
        (parsed.payload as { nested: { values: readonly string[] } }).nested
          .values,
      ),
    ).toBe(true);
  });

  it("does not accept caller-selected generic output types", () => {
    if (false) {
      // @ts-expect-error parseInformationAtom is intentionally not generic
      const parsed = parseInformationAtom<"wrong.kind", { impossible: true }>({
        informationId: "atom-3",
        kind: "acme.message.created",
        occurredAt: "2026-09-01T00:00:00.000Z",
        source: "module:acme",
        payload: { nested: { values: ["moon"] } },
        references: [],
      });
    }
  });
});
