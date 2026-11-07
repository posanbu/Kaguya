/**
 * 功能概述：用合成 PNG 验证归档读取、实时/历史投影一致及工具图片的原子裁剪。
 * 所有读取均为内存 fake，测试不接触桌面或外部模型；失败断言覆盖换图、跨 scope 和配对丢失。
 */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { NativeMessage } from "@kaguya/schema";
import { projectNativeToolResults } from "./native-tool-results.js";
import { fitToolTranscript } from "./native-tool-loop.js";
import { assembleNativeInput } from "./native-input.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1EAAAAASUVORK5CYII=",
  "base64",
);
const hash = createHash("sha256").update(png).digest("hex");
function fixture() {
  const artifact = {
    id: "artifact",
    hash,
    mime: "image/png",
    size: png.length,
    scope: "scope",
    actionId: "intent",
    generation: 1,
    observedAt: "2026-10-25T00:00:00.000Z",
    source: "environment-helper",
    retention: "explicit-delete-only",
  };
  const value = {
    status: "succeeded",
    result: {
      observation: { environmentId: "environment", generation: 1 },
      image: {
        captureId: "capture",
        coordinateFrame: "window",
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        scale: 1,
        origin: { x: 19, y: 25 },
        target: { kind: "window", pid: 12, windowId: 13 },
        sha256: hash,
        mime: "image/png",
        capturedAt: "2026-10-25T00:00:00.000Z",
        serviceInstanceId: "service",
        driverInstanceId: "driver",
      },
    },
    artifacts: [artifact],
  };
  const entry = {
    toolCallId: "call",
    toolName: "wire",
    toolId: "gui.observe",
    intentId: "intent",
    scope: "scope",
    value,
  };
  const read = vi.fn(async () => ({
    artifact,
    dataBase64: png.toString("base64"),
  }));
  const assistant: NativeMessage = {
    role: "assistant",
    content: [
      { type: "tool-call", toolCallId: "call", toolName: "wire", input: {} },
    ],
  };
  return { entry, read, assistant, artifact };
}
it("uses the original archive bytes and coordinates in both live and replayed groups", async () => {
  const f = fixture();
  const live = await projectNativeToolResults([f.entry], f.read);
  expect(f.read).toHaveBeenCalledExactlyOnceWith({
    id: "artifact",
    scope: "scope",
    environmentId: "environment",
  });
  expect(live[1]!.content).toEqual(
    expect.arrayContaining([
      {
        type: "image",
        image: `data:image/png;base64,${png.toString("base64")}`,
        mediaType: "image/png",
      },
    ]),
  );
  expect(JSON.parse((live[1]!.content as any)[0].text).image).toEqual(
    f.entry.value.result.image,
  );
  const replay = await projectNativeToolResults([f.entry], f.read);
  const atoms: any[] = [
    {
      informationId: "model",
      kind: "core.model.task.completed",
      payload: {
        taskId: "task",
        activation: { instanceId: "instance" },
        sourceInformationId: "source",
        generationKind: "tool-calls",
        toolCalls: [{ toolCallId: "call", toolName: "wire" }],
        resolvedModel: { providerId: "p", modelId: "m" },
        native: { version: 1, messages: [f.assistant], reasoning: [] },
      },
    },
    {
      informationId: "source",
      kind: "source",
      payload: { turn: { candidateInformationId: "candidate" } },
    },
    {
      informationId: "result",
      kind: "agent.heavy.tool.result.v1",
      payload: {
        modelCompletedInformationId: "model",
        toolCallId: "call",
        value: f.entry.value,
      },
    },
  ];
  const history = assembleNativeInput({
    prompt: "next",
    atoms,
    taskId: "task",
    instanceId: "instance",
    model: { providerId: "p", modelId: "m" },
    maxBytes: 20000,
    toolResults: new Map([["model", replay]]),
  });
  expect(history.slice(0, 3)).toEqual([f.assistant, ...live]);
  expect(() =>
    assembleNativeInput({
      prompt: "next",
      atoms,
      taskId: "task",
      instanceId: "instance",
      model: { providerId: "p", modelId: "m" },
      maxBytes: 20000,
    }),
  ).toThrow("NATIVE_TOOL_INTERACTION_OPEN");
  const next: NativeMessage = { role: "user", content: "next" };
  expect(fitToolTranscript([f.assistant, ...live, next], 100)).toEqual([next]);
  expect(() => fitToolTranscript([live[1]!, next], 100)).toThrow(
    "native-orphan-image",
  );
  expect(() => fitToolTranscript([f.assistant, ...live], 100)).toThrow(
    "native-context-budget",
  );
});
it.each([
  "scope",
  "intent",
  "generation",
  "hash",
  "dimensions",
  "archive",
  "bytes",
])("rejects mismatched %s without any new capture", async (change) => {
  const f = fixture();
  if (change === "scope") f.entry.scope = "other";
  if (change === "intent") f.entry.intentId = "other";
  if (change === "generation") f.entry.value.result.observation.generation = 2;
  if (change === "hash") f.entry.value.result.image.sha256 = "f".repeat(64);
  if (change === "dimensions") {
    f.entry.value.result.image.width = 2;
    f.entry.value.result.image.originalWidth = 2;
  }
  if (change === "archive")
    f.read.mockResolvedValue({
      artifact: { ...f.artifact, id: "other" },
      dataBase64: png.toString("base64"),
    });
  if (change === "bytes")
    f.read.mockResolvedValue({
      artifact: f.artifact,
      dataBase64: Buffer.from("wrong bytes").toString("base64"),
    });
  await expect(projectNativeToolResults([f.entry], f.read)).rejects.toThrow(
    /^native-image-/,
  );
  expect(f.read.mock.calls.length).toBeLessThanOrEqual(1);
});
it("counts base64 images and JSON metadata against the serialized budget", async () => {
  const f = fixture();
  await expect(projectNativeToolResults([f.entry], f.read, 64)).rejects.toThrow(
    "native-image-budget",
  );
  expect(f.read).not.toHaveBeenCalled();
});
