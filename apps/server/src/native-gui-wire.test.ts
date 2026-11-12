/**
 * 功能概述：通过真实 OpenAI-compatible SDK 的 mock fetch 核对 GUI 原始 PNG 的最终请求体。
 * 投影、序列化和历史恢复共用生产函数；HTTP 被内存响应替代，不访问外部模型服务。
 */
import { createHash } from "node:crypto";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { KaguyaLlmClient, boundedModelFetch } from "@kaguya/llm";
import { z } from "@kaguya/schema";
import { expect, it } from "vitest";
import { projectNativeToolResults } from "../../../packages/runtime/src/native-tool-results.js";

it("serializes original GUI images after the complete tool batch on live and restored requests", async () => {
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1EAAAAASUVORK5CYII=",
    "base64",
  );
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const artifact = {
    id: "blob",
    hash: sha256,
    mime: "image/png",
    size: bytes.length,
    scope: "scope",
    actionId: "intent",
    generation: 1,
  };
  const value = {
    status: "succeeded",
    artifacts: [artifact],
    result: {
      observation: { environmentId: "env", generation: 1 },
      image: {
        captureId: "original",
        coordinateFrame: "window",
        width: 1,
        height: 1,
        originalWidth: 1,
        originalHeight: 1,
        scale: 1,
        origin: { x: 27, y: 41 },
        target: { kind: "window", pid: 1, windowId: 2 },
        sha256,
        mime: "image/png",
        capturedAt: "2026-10-25T00:00:00.000Z",
        serviceInstanceId: "service",
        driverInstanceId: "driver",
      },
    },
  };
  const results = [
    {
      toolCallId: "observe",
      toolName: "gui_observe",
      toolId: "gui.observe",
      intentId: "intent",
      scope: "scope",
      value,
    },
    {
      toolCallId: "other",
      toolName: "read",
      toolId: "read",
      intentId: null,
      scope: "scope",
      value: { status: "rejected" },
    },
  ];
  const requests: any[] = [];
  const provider = createOpenAICompatible({
    name: "synthetic",
    baseURL: "https://synthetic.invalid/v1",
    apiKey: "synthetic",
    fetch: boundedModelFetch(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: "synthetic",
          model: "gui",
          object: "chat.completion",
          created: 1,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "done" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }),
  });
  const client = new KaguyaLlmClient({ model: provider.chatModel("gui") });
  for (let replay = 0; replay < 2; replay++) {
    const projected = await projectNativeToolResults(
      JSON.parse(JSON.stringify(results)),
      async () => ({ artifact, dataBase64: bytes.toString("base64") }),
    );
    await client.generate({
      modelId: "gui",
      maxInputBytes: 128000,
      outputMode: "text",
      outputSchema: z.string(),
      tools: results.map((r) => ({
        id: r.toolId,
        version: "1",
        wireName: r.toolName,
        description: "synthetic",
        inputSchema: { type: "object", properties: {} },
      })),
      messages: [
        {
          role: "assistant",
          content: results.map((r) => ({
            type: "tool-call",
            toolCallId: r.toolCallId,
            toolName: r.toolName,
            input: {},
          })),
        },
        ...projected,
      ],
    });
  }
  await expect(
    client.generate({
      modelId: "gui",
      maxInputBytes: 1,
      outputMode: "text",
      outputSchema: z.string(),
      tools: [
        {
          id: "test",
          version: "1",
          wireName: "test",
          description: "test",
          inputSchema: { type: "object" },
        },
      ],
      messages: [{ role: "user", content: "over budget" }],
    }),
  ).rejects.toThrow();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(requests[0].messages.map((m: any) => m.role)).toEqual([
    "assistant",
    "tool",
    "tool",
    "user",
  ]);
  expect(
    requests[0].messages.slice(1, 3).map((m: any) => m.tool_call_id),
  ).toEqual(["observe", "other"]);
  const image = requests[0].messages[3].content.find(
    (p: any) => p.type === "image_url",
  );
  expect(Buffer.from(image.image_url.url.split(",")[1], "base64")).toEqual(
    bytes,
  );
  expect(JSON.parse(requests[0].messages[3].content[0].text).image).toEqual(
    value.result.image,
  );
  expect(JSON.stringify(requests[0])).not.toContain("nativeToolResultGroup");
  expect(Buffer.byteLength(JSON.stringify(requests[0]))).toBeLessThan(128000);
});
