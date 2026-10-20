/**
 * 功能概述：验证 TTS 业务阶段在重放、崩溃窗口和取消时的决策。
 * 主要职责：用保留唯一槽的 handler 夹具检查重复消费及迟到结果。
 * 代码库关系：实际账本与 Runtime 链路另由 runtime.test.ts 集成覆盖。
 * 输入输出与副作用：仅使用内存端口，不访问模型或平台。
 */
import { describe, expect, it, vi } from "vitest";
import type { InformationModuleHandlerContext } from "@kaguya/sdk";
import type { DeepReadonly, InformationAtom } from "@kaguya/schema";
import type { TtsHost } from "./capability.js";
import { createTtsModule } from "./index.js";
import { ttsRequested, ttsResult, ttsStarted } from "./facts.js";
import { atom } from "../heavy/test-fixtures.js";

async function setup() {
  const request = atom("request", ttsRequested.kind, {
    taskKey: "b".repeat(64),
    assistantInformationId: "assistant",
    text: "你好",
    target: {
      platform: "qq",
      adapterId: "qq",
      destination: { kind: "group", groupId: "123" },
    },
    turn: null,
    expiresAt: "2026-10-18T10:01:00.000Z",
    identity: {
      provider: "qwen",
      accountScope: "test",
      region: "beijing",
      model: "test",
      voice: "test",
      language: "Chinese",
    },
  });
  const resource = {
    resourceId: "a".repeat(64),
    mimeType: "audio/wav" as const,
    byteLength: 48,
    durationMs: 1,
  };
  const audio = {
    ...resource,
    sha256: resource.resourceId,
    bytes: new Uint8Array(48),
    synthesizedText: "你好",
  };
  let cached: typeof resource | undefined;
  const host = {
    plan: vi.fn(),
    isCurrent: vi.fn(async () => true),
    synthesize: vi.fn<TtsHost["synthesize"]>(async () => audio),
    find: vi.fn(async () => cached),
    save: vi.fn(async () => {
      cached = resource;
      return resource;
    }),
    exists: vi.fn(async () => true),
  } satisfies TtsHost;
  const slots = new Map<string, DeepReadonly<InformationAtom>>();
  const outputs: DeepReadonly<InformationAtom>[] = [];
  let source = request;
  let failCommit = false;
  const controller = new AbortController();
  const context = {
    sourceAtom: request,
    report: async () => {},
    register: async () => {
      throw new Error("Unexpected non-durable write");
    },
    instanceId: "tts.default",
    definitionId: "agent.tts",
    signal: controller.signal,
    now: () => new Date("2026-10-18T10:00:00.000Z"),
    use: () => host,
    select: async () => outputs.filter((a) => a.kind === ttsResult.kind),
    registerOnce: async (group, key, definition, input) => {
      const id = `${group}:${key}`;
      if (slots.has(id)) return slots.get(id)!;
      const output = atom(
        `output-${outputs.length}`,
        definition.kind,
        definition.payloadSchema.parse(input.payload),
        [
          { relation: "core:caused-by", informationId: source.informationId },
          ...(input.references ?? []),
        ],
      );
      slots.set(id, output);
      outputs.push(output);
      return output;
    },
    commitTerminal: async (group, key, definition, input) => {
      if (failCommit) {
        failCommit = false;
        throw new Error("simulated crash after save");
      }
      return context.registerOnce(group, key, definition, input);
    },
  } as InformationModuleHandlerContext;
  const instance = await createTtsModule().create(
    {
      instanceId: "tts.default",
      settings: {},
      activation: { instanceId: "tts.default", definitionId: "agent.tts" },
    },
    context,
  );
  const synthesize = () => {
    source = request;
    return instance.subscriptions[0]!.handle(request, context);
  };
  const release = async () => {
    source = outputs.find((a) => a.kind === ttsResult.kind)!;
    await instance.subscriptions[1]!.handle(source, context);
  };
  return {
    host,
    slots,
    outputs,
    synthesize,
    release,
    controller,
    resource,
    crashOnCommit: () => {
      failCommit = true;
    },
    result: () =>
      ttsResult.payloadSchema.parse(
        outputs.find((a) => a.kind === ttsResult.kind)!.payload,
      ),
    deliveries: () =>
      outputs.filter((a) => a.kind === "core.delivery.requested"),
  };
}

describe("TTS durable business stages", () => {
  it("replays a completed request and release without resynthesis or duplicate delivery", async () => {
    const f = await setup();
    await f.synthesize();
    await f.synthesize();
    await f.release();
    await f.release();
    expect(f.host.synthesize).toHaveBeenCalledTimes(1);
    expect(f.deliveries()).toHaveLength(1);
    expect(f.deliveries()[0]!.payload.message).toMatchObject({
      kind: "audio",
      text: "你好",
    });
  });
  it("recovers a saved artifact after a crash before result registration", async () => {
    const f = await setup();
    f.crashOnCommit();
    await expect(f.synthesize()).rejects.toThrow("simulated crash");
    await f.synthesize();
    await f.release();
    expect(f.host.synthesize).toHaveBeenCalledTimes(1);
    expect(f.result().outcome.status).toBe("completed");
    expect(f.deliveries()).toHaveLength(1);
  });
  it("does not repeat an uncertain external call after restart", async () => {
    const f = await setup();
    f.slots.set(
      "kaguya.tts.attempt.v1:request",
      atom("old-attempt", ttsStarted.kind, { attempt: "previous-process" }),
    );
    await f.synthesize();
    await f.release();
    expect(f.host.synthesize).not.toHaveBeenCalled();
    expect(f.result().outcome).toEqual({
      status: "failed",
      reason: "outcome_unknown",
    });
    expect(f.deliveries()[0]!.payload).toMatchObject({
      message: { kind: "text" },
      ttsFallbackReason: "outcome_unknown",
    });
  });
  it("records a safe failure and falls back once", async () => {
    const f = await setup();
    f.host.synthesize.mockRejectedValue(new Error("SECRET"));
    await f.synthesize();
    await f.release();
    await f.release();
    expect(f.deliveries()).toHaveLength(1);
    expect(f.deliveries()[0]!.payload.ttsFallbackReason).toBe(
      "synthesis_failed",
    );
    expect(JSON.stringify(f.outputs)).not.toContain("SECRET");
  });
  it("records resource loss and keeps the original text", async () => {
    const f = await setup();
    await f.synthesize();
    f.host.exists.mockResolvedValue(false);
    await f.release();
    expect(f.deliveries()[0]!.payload).toMatchObject({
      message: { kind: "text", text: "你好" },
      ttsFallbackReason: "resource_missing",
    });
  });
  it("does not synthesize or deliver after authorization expires", async () => {
    const f = await setup();
    f.host.isCurrent.mockResolvedValue(false);
    await f.synthesize();
    await f.release();
    expect(f.host.synthesize).not.toHaveBeenCalled();
    expect(f.deliveries()).toHaveLength(0);
  });
  it("cancels a prepared audio delivery when authorization changes during resource lookup", async () => {
    const f = await setup();
    await f.synthesize();
    f.host.exists.mockImplementation(async () => {
      f.host.isCurrent.mockResolvedValue(false);
      return true;
    });
    await f.release();
    await f.release();
    expect(f.deliveries()).toHaveLength(0);
    expect(
      f.outputs.filter((a) => a.kind === "agent.tts.delivery.cancelled"),
    ).toHaveLength(1);
    expect(f.host.synthesize).toHaveBeenCalledTimes(1);
  });
  it("falls back once when storing a synthesized artifact fails", async () => {
    const f = await setup();
    f.host.save.mockRejectedValue(new Error("private-storage-error"));
    await f.synthesize();
    await f.synthesize();
    await f.release();
    await f.release();
    expect(f.host.synthesize).toHaveBeenCalledTimes(1);
    expect(f.deliveries()).toHaveLength(1);
    expect(f.deliveries()[0]!.payload).toMatchObject({
      message: { kind: "text", text: "你好" },
      ttsFallbackReason: "storage_failed",
    });
    expect(JSON.stringify(f.outputs)).not.toContain("private-storage-error");
  });
  it("discards synthesis completing after cancellation", async () => {
    const f = await setup();
    const started = Promise.withResolvers<void>();
    const finish =
      Promise.withResolvers<Awaited<ReturnType<TtsHost["synthesize"]>>>();
    f.host.synthesize.mockImplementation(async () => {
      started.resolve();
      return finish.promise;
    });
    const running = f.synthesize();
    await started.promise;
    f.controller.abort();
    finish.resolve({
      bytes: new Uint8Array(48),
      sha256: f.resource.resourceId,
      mimeType: "audio/wav",
      durationMs: 1,
      synthesizedText: "你好",
    });
    await running;
    await f.release();
    expect(f.host.save).not.toHaveBeenCalled();
    expect(f.deliveries()).toHaveLength(0);
    expect(f.result().outcome.status).toBe("cancelled");
  });
});
