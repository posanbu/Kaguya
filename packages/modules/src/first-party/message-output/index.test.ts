/**
 * 功能概述：验证默认输出处理器保留有序媒体、纯媒体、表情与 speech，且使用同一幂等投递键。
 * 以合成授权事实调用真实 handler；无模型、平台或数据库 I/O。schema 断言拒绝缺请求和错正文。
 */
import { describe, expect, it, vi } from "vitest";
import { textMessageOutputModule } from "./index.js";
import { assistantTextInformationKind } from "../kinds/message.js";

const mediaId = `media:${"a".repeat(64)}`;
const speech = {
  intentInformationId: "intent",
  stepInformationId: "step",
  stepIndex: 0,
  completedInformationId: "completed",
  continuation: "next",
  readyAt: "2026-11-07T00:00:00.000Z",
};
function payload(text: string, contentSegments?: unknown[]) {
  return {
    text,
    source: {
      platform: "qq",
      adapterId: "napcat",
      destination: { kind: "private", userId: "42" },
    },
    originatingModuleInstanceId: "heavy",
    turn: null,
    speech,
    ...(contentSegments
      ? { contentSegments, mediaRequestInformationId: "model-request" }
      : {}),
  };
}
describe("authorized ordered output", () => {
  it.each([
    [
      "beforeafter",
      [
        { kind: "text", text: "before" },
        { kind: "mediaRef", mediaId },
        { kind: "text", text: "after" },
      ],
    ],
    ["", [{ kind: "mediaRef", mediaId }]],
  ])(
    "preserves ordered segments and pure media (%s)",
    async (text, segments) => {
      const input = assistantTextInformationKind.payloadSchema.parse(
        payload(text as string, segments as unknown[]),
      );
      const instance = await textMessageOutputModule.create(
        {
          settings: {},
          activation: {
            instanceId: "output",
            definitionId: "agent.message-output.text",
          },
        } as never,
        {} as never,
      );
      const registerOnce = vi.fn();
      const source = {
        informationId: "authorized",
        payload: input,
        references: [
          { relation: "core:caused-by", informationId: "assistant" },
        ],
      };
      await instance.subscriptions![0]!.handle(
        source as never,
        { registerOnce } as never,
      );
      expect(registerOnce).toHaveBeenCalledExactlyOnceWith(
        "agent.message-output.text.delivery.v1",
        "authorized",
        expect.anything(),
        expect.objectContaining({
          causedByInformationId: "assistant",
          payload: expect.objectContaining({
            speech,
            message: {
              kind: "content",
              text,
              segments,
              requestInformationId: "model-request",
            },
          }),
        }),
      );
    },
  );
  it("rejects forged text and absent frozen request IDs", () => {
    const valid = payload("", [{ kind: "mediaRef", mediaId }]);
    expect(() =>
      assistantTextInformationKind.payloadSchema.parse({
        ...valid,
        text: "hidden",
      }),
    ).toThrow();
    expect(() =>
      assistantTextInformationKind.payloadSchema.parse({
        ...valid,
        mediaRequestInformationId: undefined,
      }),
    ).toThrow();
  });
});
