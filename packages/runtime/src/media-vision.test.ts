/**
 * 功能概述：用合成图片与受控模型替身验证外挂视觉 ModelTask 和媒体快照的持久语义。
 * fixture 使用真实 Core/PGlite 或隔离 PostgreSQL、媒体来源仓储与模型任务登记；不访问外部模型。
 * 覆盖观察缓存重建、模型配置切换、失败以及取消后迟到结果，断言旧快照不可变。
 * 使用显式 Promise barrier 控制并发顺序；每例关闭 Core 和数据库，不依赖固定等待。
 */
import {
  createPostgresTestingDatabaseScope,
  createTestingDatabase,
} from "@kaguya/database/testing";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { createStructuredOutputPromptRenderer } from "@kaguya/llm";
import type { KaguyaLlmClient } from "@kaguya/llm/client";
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  modelTaskInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import { createMediaVisionObserver } from "./media-vision.js";

const sourceKind = defineInformationKind({
  kind: "test.media.vision.source",
  displayName: "Synthetic source",
  description: "Synthetic source for media vision",
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
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(postgresUrl?: string) {
  const scope = postgresUrl
    ? await createPostgresTestingDatabaseScope(postgresUrl)
    : undefined;
  let db = scope ? await scope.connect() : await createTestingDatabase();
  cleanups.push(() => (scope ? scope.close() : db.close()));
  await db.prepareSchema();
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContextInformationKind);
  for (const kind of modelTaskInformationKinds) registry.registerBuiltin(kind);
  registry.register(sourceKind);
  let id = 0;
  const createCore = () =>
    new InformationCore({
      registry,
      store: db.information,
      nextInformationId: () => `vision-test-${++id}`,
    });
  let core = createCore();
  await core.start();
  cleanups.push(() => core.close());
  const base = {
    occurredAt: "2026-01-01T00:00:00.000Z",
    source: "test:fixture",
    references: [],
  };
  const context = await core.register(runtimeContextInformationKind, {
    ...base,
    payload: {},
  });
  const source = await core.register(sourceKind, {
    ...base,
    payload: { text: "synthetic" },
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
      text: "synthetic",
      variables: [
        {
          name: "source",
          content: "synthetic",
          informationIds: [source.informationId],
        },
      ],
    },
  };
  const input = {
    key: "outer",
    mediaId: "media:synthetic",
    frames: [
      {
        bytes: Buffer.from("synthetic"),
        mimeType: "image/png" as const,
        atMs: 0,
      },
    ],
  };
  async function reconnect() {
    if (!scope) throw new Error("PostgreSQL scope required");
    await core.close();
    await db.close();
    db = await scope.reconnect();
    await db.prepareSchema();
    core = createCore();
    await core.start();
    return { db, core };
  }
  return { db, core, context, request, input, reconnect };
}
const renderStructuredOutputPrompt = createStructuredOutputPromptRenderer(
  "JSON schema: {{json_schema}}",
);

it("reconstructs an observer from persistent cache and separates model identities", async () => {
  const f = await fixture();
  const generate = vi
    .fn()
    .mockResolvedValueOnce({
      output: { description: "first model" },
      durationMs: 1,
    })
    .mockResolvedValueOnce({
      output: { description: "second model" },
      durationMs: 1,
    });
  let modelId = "one";
  const options = {
    client: { generate } as Pick<KaguyaLlmClient, "generate">,
    resolveModel: () => ({ providerId: "test", modelId }),
    renderStructuredOutputPrompt,
  };
  const first = await createMediaVisionObserver(
    f.core,
    f.db.mediaSources,
    "scope",
    options,
    f.request,
  )(f.input, new AbortController().signal);
  const replay = await createMediaVisionObserver(
    f.core,
    f.db.mediaSources,
    "scope",
    options,
    f.request,
  )({ ...f.input, key: "another" }, new AbortController().signal);
  expect(replay).toEqual(first);
  expect(generate).toHaveBeenCalledTimes(1);
  const parts = (
    generate.mock.calls[0]![0] as {
      messages: { role: string; content: unknown }[];
    }
  ).messages;
  const image = (
    parts.find((p) => p.role === "user" && Array.isArray(p.content))!
      .content as { type: string; image: string }[]
  ).find((part) => part.type === "file")!;
  expect(image).toEqual({
    type: "file",
    mediaType: "image/png",
    data: { type: "data", data: Buffer.from("synthetic").toString("base64") },
  });
  modelId = "two";
  const second = await createMediaVisionObserver(
    f.core,
    f.db.mediaSources,
    "scope",
    options,
    f.request,
  )(f.input, new AbortController().signal);
  expect(second.text).toBe("second model");
  expect(second.modelIdentity).toContain('"modelId":"two"');
  expect(generate).toHaveBeenCalledTimes(2);
});

it("does not store a successful observation on provider failure", async () => {
  const f = await fixture();
  const generate = vi.fn().mockRejectedValue(new Error("provider secret"));
  const options = {
    client: { generate } as Pick<KaguyaLlmClient, "generate">,
    resolveModel: () => ({ providerId: "test", modelId: "one" }),
    renderStructuredOutputPrompt,
  };
  await expect(
    createMediaVisionObserver(
      f.core,
      f.db.mediaSources,
      "scope",
      options,
      f.request,
    )(f.input, new AbortController().signal),
  ).rejects.toThrow("media-vision-task-unavailable");
  const atoms = await f.core.query({ informationId: f.context.informationId });
  expect(atoms.filter((a) => a.kind === "core.model.task.failed")).toHaveLength(
    1,
  );
  expect(
    atoms.filter((a) => a.kind === "core.model.task.completed"),
  ).toHaveLength(0);
  expect(JSON.stringify(atoms)).not.toContain("provider secret");
});

it("keeps an earlier unavailable snapshot unchanged when a cancelled observer returns late", async () => {
  const f = await fixture();
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let providerSignal: AbortSignal | undefined;
  const generate = vi.fn(async (request: { signal?: AbortSignal }) => {
    providerSignal = request.signal;
    entered();
    await barrier;
    return { output: { description: "late" }, durationMs: 1 };
  });
  const options = {
    client: { generate } as Pick<KaguyaLlmClient, "generate">,
    resolveModel: () => ({ providerId: "test", modelId: "one" }),
    renderStructuredOutputPrompt,
  };
  const observe = createMediaVisionObserver(
    f.core,
    f.db.mediaSources,
    "scope",
    options,
    f.request,
  );
  const controller = new AbortController();
  const pending = observe(f.input, controller.signal);
  try {
    await started;
    controller.abort();
    expect(providerSignal?.aborted).toBe(true);
    const before = await f.core.query({
      informationId: f.context.informationId,
    });
    expect(
      before.filter((a) => a.kind === "core.model.task.requested"),
    ).toHaveLength(1);
    expect(
      before.filter((a) =>
        [
          "core.model.task.completed",
          "core.model.task.failed",
          "core.model.task.cancelled",
        ].includes(a.kind),
      ),
    ).toHaveLength(0);
    const unavailable = await f.db.mediaSources.freeze(
      "heavy-snapshot",
      "scope",
      async () => ({ status: "vision-unavailable" }),
    );
    release();
    const late = await pending;
    expect(late.text).toBe("late");
    const after = await f.core.query({
      informationId: f.context.informationId,
    });
    expect(
      after.filter((a) => a.kind === "core.model.task.completed"),
    ).toHaveLength(1);
    expect(
      after.filter((a) =>
        ["core.model.task.failed", "core.model.task.cancelled"].includes(
          a.kind,
        ),
      ),
    ).toHaveLength(0);
    expect(
      await f.db.mediaSources.freeze("heavy-snapshot", "scope", async () => ({
        status: "external",
        text: "late",
      })),
    ).toEqual(unavailable);
    expect(
      await createMediaVisionObserver(
        f.core,
        f.db.mediaSources,
        "scope",
        options,
        f.request,
      )(f.input, new AbortController().signal),
    ).toEqual(late);
    expect(generate).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await pending.catch(() => {});
  }
});

const pgUrl = process.env.KAGUYA_TEST_DATABASE_URL?.trim();
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !pgUrl)
  throw new Error("PostgreSQL test URL required");
it.skipIf(!pgUrl)(
  "reuses a completed visual observation after PostgreSQL reconnect and Core reconstruction",
  async () => {
    const f = await fixture(pgUrl);
    const generate = vi.fn().mockResolvedValue({
      output: { description: "persisted observation" },
      durationMs: 1,
    });
    const options = {
      client: { generate } as Pick<KaguyaLlmClient, "generate">,
      resolveModel: () => ({ providerId: "test", modelId: "one" }),
      renderStructuredOutputPrompt,
    };
    const original = await createMediaVisionObserver(
      f.core,
      f.db.mediaSources,
      "scope",
      options,
      f.request,
    )(f.input, new AbortController().signal);
    const before = await f.core.query({
      informationId: f.context.informationId,
    });
    expect(
      before.filter((a) => a.kind === "core.model.task.completed"),
    ).toHaveLength(1);
    const restarted = await f.reconnect();
    const mustNotGenerate = vi
      .fn()
      .mockRejectedValue(new Error("unexpected provider request"));
    const replay = await createMediaVisionObserver(
      restarted.core,
      restarted.db.mediaSources,
      "scope",
      {
        ...options,
        client: { generate: mustNotGenerate } as Pick<
          KaguyaLlmClient,
          "generate"
        >,
      },
      f.request,
    )({ ...f.input, key: "new-request" }, new AbortController().signal);
    expect(replay).toEqual(original);
    expect(replay).toMatchObject({
      text: "persisted observation",
      modelIdentity: original.modelIdentity,
      completedAt: original.completedAt,
    });
    expect(mustNotGenerate).not.toHaveBeenCalled();
    const after = await restarted.core.query({
      informationId: f.context.informationId,
    });
    expect(
      after.filter((a) => a.kind === "core.model.task.completed"),
    ).toHaveLength(1);
    expect(
      after.filter((a) => a.kind === "core.model.task.requested"),
    ).toHaveLength(1);
  },
);
