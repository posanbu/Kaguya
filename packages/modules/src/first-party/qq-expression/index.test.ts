/**
 * 功能概述：以真实 PGlite/Core 验证独立表情收藏、证据校验、会话隔离与重启去重。
 * cognitiveFixture 只替换外部模型，所有语义、引用、幂等和后台结束状态仍经真实宿主。
 * 等待以持久化队列收敛为边界，预算 8 秒/20 毫秒；每例 finally 关闭资源。
 */
import { describe, it, expect, vi } from "vitest";
import {
  cognitiveFixture,
  modelToken,
} from "../test-support/cognitive-fixture.js";
import { createQqExpressionModule } from "./index.js";
import { collected, learned, observed } from "./facts.js";
import { inboundTextInformationKind } from "../information-kinds.js";
import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import type { ModelTaskRequest } from "../message-composer/index.js";
const wait = { timeout: 8000, interval: 20 };
async function setup(invalid = false) {
  const requests: ModelTaskRequest<unknown>[] = [];
  const cacheSticker = vi.fn(async () => "base64://R0lGODlh");
  const f = await cognitiveFixture(
    [
      createQqExpressionModule({
        modelTaskCapability: modelToken,
        templates: loadFirstPartyPromptTemplates().qqExpression,
        cacheSticker,
      }),
    ],
    (request) => {
      requests.push(request);
      return {
        meaning: "好笑的无奈",
        usage: "友好自嘲",
        confidence: 0.95,
        evidenceIds: [
          invalid
            ? "fabricated"
            : request.contextAtoms.find((a) =>
                String(a.payload.text).includes("哈哈"),
              )!.informationId,
        ],
      };
    },
  );
  const settle = () =>
    vi.waitFor(
      async () =>
        expect((await f.database.information.reliable.health()).pending).toBe(
          0,
        ),
      wait,
    );
  const inbound = async (
    group: string,
    text = "哈哈这次又翻车了[image]",
    image = true,
  ) => {
    const root = await f.context();
    return f.core.register(inboundTextInformationKind, {
      source: "adapter:test",
      occurredAt: new Date(now).toISOString(),
      payload: {
        text,
        source: {
          platform: "qq",
          adapterId: "qq",
          platformMessageId: root.informationId,
          destination: { kind: "group", groupId: group },
          senderId: "human",
          selfId: "bot",
          expressions: image
            ? [
                {
                  kind: "sticker",
                  id: "same.gif",
                  url: "https://gchat.qpic.cn/test",
                },
              ]
            : [{ kind: "face", id: "14" }],
        },
      },
      references: [
        { relation: "core:context", informationId: root.informationId },
      ],
    });
  };
  let now = Date.parse("2026-09-09T00:00:10.000Z");
  return {
    ...f,
    requests,
    cacheSticker,
    settle,
    inbound,
    advance() {
      now += 61000;
      f.setNow(new Date(now).toISOString());
    },
  };
}
describe("QQ expression collection", () => {
  it("persists an image without multimodal input, isolates groups, and reuses bytes after restart", async () => {
    const f = await setup();
    try {
      await f.inbound("one");
      await f.settle();
      expect(
        (await f.all()).filter((a) => /failed|exhausted/.test(a.kind)),
      ).toEqual([]);
      expect(await f.all(collected.kind)).toHaveLength(1);
      expect((await f.all(learned.kind))[0]?.payload).toMatchObject({
        basis: "context-inference",
        confidence: 0.95,
      });
      expect(JSON.stringify(f.requests)).not.toContain("base64://");
      await f.restart();
      f.advance();
      await f.inbound("one");
      await f.settle();
      expect(await f.all(collected.kind)).toHaveLength(1);
      await vi.waitFor(
        async () => expect(await f.all(observed.kind)).toHaveLength(2),
        wait,
      );
      expect(f.cacheSticker).toHaveBeenCalledTimes(1);
      await f.inbound("two");
      await f.settle();
      expect(await f.all(collected.kind)).toHaveLength(2);
      expect(
        f.requests
          .at(-1)
          ?.contextAtoms.filter(
            (a) => a.kind === inboundTextInformationKind.kind,
          )
          .every((a) => JSON.stringify(a.payload).includes('"groupId":"two"')),
      ).toBe(true);
    } finally {
      await f.close();
    }
  });
  it("stores unknown semantics when evidence IDs are fabricated", async () => {
    const f = await setup(true);
    try {
      await f.inbound("one", "哈哈你好[face:14]", false);
      await f.settle();
      expect((await f.all(learned.kind))[0]?.payload).toMatchObject({
        confidence: 0,
        meaning: "",
        evidenceIds: [],
      });
      expect(f.cacheSticker).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
