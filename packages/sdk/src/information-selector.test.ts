/**
 * 功能概述：验证 Information Selector 的 SDK 公共入口与定义期基础约束。
 * 主要职责：确认公共入口导出 `defineInformationSelector`，并验证 selectorId 的
 * 规范化、空值拒绝和定义冻结语义。
 * 代码库关系：本测试只通过 `index.ts` 使用公开 API，避免依赖实现文件的私有结构；
 * Engine 后续会消费同一 Selector definition 执行受控账本读取。
 * 输入输出与副作用：测试仅创建内存定义，不访问账本、数据库或运行时。
 */
import { describe, expect, it } from "vitest";

import * as sdk from "./index.js";

function selectorFactory() {
  expect(sdk).toHaveProperty("defineInformationSelector");
  return (
    sdk as typeof sdk & {
      defineInformationSelector: (input: {
        selectorId: string;
        select: () => readonly string[];
      }) => { selectorId: string; select: () => readonly string[] };
    }
  ).defineInformationSelector;
}

describe("defineInformationSelector", () => {
  it("normalizes a non-blank selector id and freezes the definition", () => {
    const defineInformationSelector = selectorFactory();
    const select = () => ["information-1"] as const;
    const definition = defineInformationSelector({
      selectorId: "  reply.current  ",
      select,
    });

    expect(definition).toEqual({ selectorId: "reply.current", select });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it.each(["", "   "])("rejects a blank selector id %j", (selectorId) => {
    const defineInformationSelector = selectorFactory();
    expect(() =>
      defineInformationSelector({ selectorId, select: () => [] }),
    ).toThrow("information selector id must not be blank");
  });
});

sdk.defineInformationSelector({
  selectorId: "invalid.atom-result",
  // @ts-expect-error Selector 结果只能包含 informationId，不能直接返回 atom。
  select: () => [{ informationId: "information-1" }],
});
