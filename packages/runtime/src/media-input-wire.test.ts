/**
 * 功能概述：验证通用媒体的 native 与 external 输入经过 AI SDK 和 OpenAI-compatible 编码后的真实请求体。
 * 使用合成 PNG、PGlite 和纯内存 fetch 替身；prepareHeavyMedia、视觉 ModelTask 与 LLM client 使用生产入口。
 * 同时检查 SDK 输入采用 file 数据段、wire 的 image_url 可还原原字节，并拒绝旧 image 段。
 * 不执行网络请求或调用外部模型；每个测试关闭 Core 与数据库。
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createTestingDatabase } from "@kaguya/database/testing";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { createStructuredOutputPromptRenderer } from "@kaguya/llm";
import { z, type NativeMessage } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { expect, it } from "vitest";
import {
  modelTaskInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import { prepareHeavyMedia } from "./media-input.js";
import { createMediaVisionObserver } from "./media-vision.js";

// 从生产 LLM 包解析其依赖，确保测试使用实际安装的 SDK，而非仓库中其他版本。
const requireLlm = createRequire(
  import.meta.resolve("@kaguya/llm/openai-compatible"),
);
const { createOpenAICompatible } = requireLlm(
  "@ai-sdk/openai-compatible",
) as typeof import("../../llm/node_modules/@ai-sdk/openai-compatible/dist/index.js");
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1EAAAAASUVORK5CYII=",
  "base64",
);
const sourceKind = defineInformationKind({
  kind: "test.media.wire.source",
  displayName: "Synthetic source",
  description: "Synthetic wire test source",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
  },
  log: { enabled: false },
});

it("sends identical native and external image bytes through the installed SDK", async () => {
  const db = await createTestingDatabase();
  await db.prepareSchema();
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContextInformationKind);
  for (const kind of modelTaskInformationKinds) registry.registerBuiltin(kind);
  registry.register(sourceKind);
  let id = 0;
  const core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: () => `media-wire-${++id}`,
  });
  try {
    await core.start();
    const base = {
      occurredAt: "2026-01-01T00:00:00.000Z",
      source: "test:wire",
      references: [],
    };
    const context = await core.register(runtimeContextInformationKind, {
      ...base,
      payload: {},
    });
    const source = await core.register(sourceKind, {
      ...base,
      payload: { text: "image" },
      references: [
        { relation: "core:context", informationId: context.informationId },
      ],
    });
    const request = {
      task: {
        taskId: "test.heavy",
        outputMode: "object" as const,
        outputSchema: z.object({ text: z.string() }),
        allowedTiers: ["heavy"] as const,
      },
      sourceInformationId: source.informationId,
      contextInformationId: context.informationId,
      contextAtoms: [source],
      activation: { instanceId: "test.one", definitionId: "test.module" },
      selectionPolicy: { tier: "heavy" as const },
      prompt: {
        kind: "message" as const,
        templateId: "test.prompt",
        templates: [{ name: "main", content: "{{source}}" }],
        text: "image",
        variables: [
          {
            name: "source",
            content: "image",
            informationIds: [source.informationId],
          },
        ],
      },
    };
    const sha256 = createHash("sha256").update(png).digest("hex"),
      resourceId = `sha256:${sha256}`;
    const ref = {
      mediaId: `media:${"a".repeat(64)}`,
      position: 0,
      mediaType: "image" as const,
      status: "available" as const,
      resourceId,
      mimeType: "image/png" as const,
      byteLength: png.length,
    };
    await db.mediaSources.put("scope", "message:0", ref);
    const resources = {
      get: async (id: string) =>
        id === resourceId
          ? { resourceId, bytes: png, mimeType: "image/png", sha256 }
          : undefined,
      put: async () => {},
      delete: async () => {},
      cleanupExpired: async () => 0,
    };
    const bodies: { messages: { role: string; content: unknown }[] }[] = [];
    const provider = createOpenAICompatible({
      name: "synthetic",
      baseURL: "https://synthetic.invalid/v1",
      fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(
          JSON.stringify({
            id: "synthetic",
            model: "test",
            object: "chat.completion",
            created: 1,
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content:
                    bodies.length === 1
                      ? "done"
                      : '{"description":"synthetic image"}',
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const client = new KaguyaLlmClient({ model: provider.chatModel("test") });
    const model = { providerId: "test", modelId: "test" };
    const native = await prepareHeavyMedia({
      key: "native-wire",
      scope: "scope",
      refs: [ref],
      model,
      sources: db.mediaSources,
      resources,
      options: { mode: "native", nativeModel: model },
    });
    const sdkInputs: NativeMessage[][] = [native];
    await client.generate({
      modelId: "test",
      messages: native,
      outputMode: "text",
      outputSchema: z.string(),
    });
    const observer = createMediaVisionObserver(
      core,
      db.mediaSources,
      "scope",
      {
        client: {
          generate: async (input) => {
            sdkInputs.push(input.messages!);
            return client.generate(input);
          },
        },
        resolveModel: () => model,
        renderStructuredOutputPrompt: createStructuredOutputPromptRenderer(
          "JSON schema: {{json_schema}}",
        ),
      },
      request,
    );
    const observation = await observer(
      {
        key: "external-wire",
        mediaId: ref.mediaId,
        frames: [{ bytes: png, mimeType: "image/png", atMs: 0 }],
      },
      new AbortController().signal,
    );
    expect(observation.text).toBe("synthetic image");
    expect(sdkInputs).toHaveLength(2);
    expect(bodies).toHaveLength(2);
    for (const messages of sdkInputs) {
      const parts = messages.flatMap((m) =>
        Array.isArray(m.content) ? m.content : [],
      );
      expect(parts).not.toContainEqual(
        expect.objectContaining({ type: "image" }),
      );
      expect(parts).toContainEqual({
        type: "file",
        mediaType: "image/png",
        data: { type: "data", data: png.toString("base64") },
      });
    }
    for (const body of bodies) {
      const parts = body.messages.flatMap((m) =>
        Array.isArray(m.content) ? m.content : [],
      ) as { type: string; image_url?: { url: string } }[];
      const urls = parts
        .filter((p) => p.type === "image_url")
        .map((p) => p.image_url!.url);
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/^data:image\/png;base64,/);
      expect(Buffer.from(urls[0]!.split(",")[1]!, "base64")).toEqual(png);
    }
  } finally {
    await core.close();
    await db.close();
  }
});
