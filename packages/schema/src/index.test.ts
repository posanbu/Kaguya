/**
 * 功能概述：验证 schema 包保留的信息原子时代共享边界，覆盖 Prompt fragment 与平台
 * 消息内容的严格解析，不再为已删除的事件或记录身份建立测试依赖。
 * 主要职责：确认 fragment source 拒绝未知值；确认 reply 内容保留外部平台消息 ID，
 * 且严格 schema 会拒绝未声明字段。
 * 代码库关系：直接测试 `index.ts` 的公共 schema；prompt、modules 与 platform adapters
 * 依赖相同解析结果，因此这些断言保护跨包 wire contract。
 * 输入输出与副作用：测试只解析内存对象，不访问网络或持久化；失败以 Zod 异常体现。
 */
import { describe, expect, it } from "vitest";

import { outboundMessageContentSchema, promptFragmentSchema } from "./index.js";

describe("promptFragmentSchema", () => {
  it("rejects an unsupported fragment source", () => {
    expect(promptFragmentSchema).toBeDefined();

    expect(() =>
      promptFragmentSchema.parse({
        id: "fragment-1",
        source: "unsupported",
        priority: 1,
        content: "instructions",
        metadata: {},
      }),
    ).toThrow();
  });
});

describe("outboundMessageContentSchema", () => {
  it("preserves an external platform reply identity", () => {
    expect(
      outboundMessageContentSchema.parse({
        kind: "reply",
        replyToPlatformMessageId: "platform-1",
        text: "hello",
      }),
    ).toEqual({
      kind: "reply",
      replyToPlatformMessageId: "platform-1",
      text: "hello",
    });
  });

  it("rejects undeclared message fields", () => {
    expect(() =>
      outboundMessageContentSchema.parse({
        kind: "text",
        text: "hello",
        internalIdentity: "legacy",
      }),
    ).toThrow();
  });
});
