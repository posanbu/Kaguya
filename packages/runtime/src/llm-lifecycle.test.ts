/**
 * 功能概述：以真实 PGlite 账本验证 Runtime 的 LLM requested/completed/failed 原子生命周期。
 * 主要职责：成功路径检查直接因果、status-of、context、有序 uses-context、usage 与
 * duration；在 provider 前拒绝 Prompt provenance 与选择不一致；失败路径检查先落账
 * `core.llm.failed` 再重抛分类后的 `KaguyaLlmError`，并约束日志投影不暴露敏感正文。
 * 代码库关系：测试组合 `InformationCore`、Runtime kind 和底层 `KaguyaLlmClient`，对应
 * `createLlmReplyModule` 注入 executor 的真实持久化边界。
 * 输入输出与副作用：每个用例创建隔离的内存 PostgreSQL 实例，注册完整内建 kind，结束后
 * 关闭 Core 与数据库；provider secret/database URL 只作为泄漏探针，不应出现在投影中。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  InformationCore,
  InformationKindRegistry,
  consumerFailedInformationKind,
} from "@kaguya/engine";
import { KaguyaLlmClient, KaguyaLlmError } from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import {
  coreMemoryTextInformationKind,
  inboundTextInformationKind,
  replyRequestedInformationKind,
  type ReplyRequestedInformationPayload,
} from "@kaguya/modules";
import type {
  CompiledPrompt,
  DeepReadonly,
  InformationAtom,
  InformationId,
} from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import {
  builtInInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";
import { LlmLifecycleClient } from "./llm-lifecycle.js";

const TEST_TIMEOUT = 15_000;
function tracedPrompt(
  informationIds: readonly InformationId[],
): CompiledPrompt {
  return {
    kind: "reply",
    text: "credential=never-log-this database=postgresql://secret",
    fragments: informationIds.map((informationId, index) => ({
      id: `fragment-${index}`,
      informationId,
      source: informationId.startsWith("memory-") ? "memory" : "history",
      priority: 20,
      content: `content-${index}`,
      metadata: {},
    })),
    provenance: informationIds.map((informationId, index) => ({
      fragmentId: `fragment-${index}`,
      informationId,
      source: informationId.startsWith("memory-") ? "memory" : "history",
      priority: 20,
      contentDigest: `digest-${index}`,
    })),
  };
}

function lifecycleRequest(
  prompt: CompiledPrompt,
  contextAtoms: readonly DeepReadonly<InformationAtom>[],
  reply: DeepReadonly<
    InformationAtom<"core.reply.requested", ReplyRequestedInformationPayload>
  >,
) {
  return {
    kind: "reply" as const,
    modelId: "deterministic-heavy",
    workflowId: "message-module-pipeline",
    nodeId: "reply.default",
    originatingModuleInstanceId: "reply.default",
    prompt,
    contextAtoms,
    reply: reply.payload,
  };
}

async function llmRequestedAtoms(
  database: Awaited<ReturnType<typeof createTestingDatabase>>,
  context: DeepReadonly<InformationAtom<"core.runtime.context">>,
) {
  return (
    await database.information.query({
      informationId: context.informationId,
    })
  ).filter(({ kind }) => kind === "core.llm.requested");
}

async function createFixture(
  model: ReturnType<typeof createRepeatingDeterministicModel>,
  client?: KaguyaLlmClient,
) {
  const database = await createTestingDatabase();
  await database.migrate();
  const registry = new InformationKindRegistry();
  for (const definition of builtInInformationKinds) {
    if (definition === consumerFailedInformationKind) continue;
    if (definition.kind.startsWith("core."))
      registry.registerBuiltin(definition);
    else registry.register(definition);
  }
  let id = 0;
  const core = new InformationCore({
    registry,
    store: database.information,
    nextInformationId: () => `llm-atom-${++id}`,
  });
  await core.start();
  const context = await core.register(runtimeContextInformationKind, {
    occurredAt: "2026-09-04T00:00:00.000Z",
    source: "runtime:test",
    payload: {},
    references: [],
  });
  const inbound = await core.register(inboundTextInformationKind, {
    occurredAt: "2026-09-04T00:00:01.000Z",
    source: "runtime:test",
    payload: {
      text: "hello",
      source: {
        adapterId: "web.ui.main",
        platform: "web",
        platformMessageId: "request-1",
        destination: { kind: "web" },
        senderId: "web",
      },
    },
    references: [
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const reply = await core.register(replyRequestedInformationKind, {
    occurredAt: "2026-09-04T00:00:02.000Z",
    source: "runtime:test",
    payload: inbound.payload,
    references: [
      { relation: "core:caused-by", informationId: inbound.informationId },
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const memory = await core.register(coreMemoryTextInformationKind, {
    occurredAt: "2026-09-04T00:00:02.500Z",
    source: "runtime:test",
    payload: { text: "likes tea" },
    references: [
      { relation: "core:caused-by", informationId: reply.informationId },
      { relation: "core:context", informationId: context.informationId },
      { relation: "core:uses-context", informationId: reply.informationId },
    ],
  });
  const lifecycle = new LlmLifecycleClient({
    core,
    client:
      client ??
      new KaguyaLlmClient({
        model,
        now: (() => {
          const values = [
            new Date("2026-09-04T00:00:03.000Z"),
            new Date("2026-09-04T00:00:03.025Z"),
          ];
          return () => values.shift() ?? new Date("2026-09-04T00:00:03.025Z");
        })(),
      }),
    now: () => new Date("2026-09-04T00:00:03.000Z"),
  });
  return { database, core, context, reply, memory, lifecycle };
}

describe("LlmLifecycleClient", () => {
  it(
    "registers requested then completed with direct status and context links",
    async () => {
      const fixture = await createFixture(
        createRepeatingDeterministicModel({ text: "Moonlight." }),
      );

      const completed = await fixture.lifecycle.generate(
        lifecycleRequest(
          tracedPrompt([
            fixture.memory.informationId,
            fixture.reply.informationId,
          ]),
          [fixture.memory, fixture.reply],
          fixture.reply,
        ),
        fixture.context,
        fixture.reply,
      );

      const observed = await fixture.database.information.query({
        informationId: fixture.context.informationId,
      });
      const lifecycleAtoms = observed.filter(({ kind }) =>
        kind.startsWith("core.llm."),
      );
      expect(lifecycleAtoms.map((atom) => atom.kind)).toEqual([
        "core.llm.requested",
        "core.llm.completed",
      ]);
      const requested = lifecycleAtoms[0]!;
      expect(requested.references).toEqual([
        {
          relation: "core:caused-by",
          informationId: fixture.reply.informationId,
        },
        {
          relation: "core:context",
          informationId: fixture.context.informationId,
        },
        {
          relation: "core:uses-context",
          informationId: fixture.memory.informationId,
        },
        {
          relation: "core:uses-context",
          informationId: fixture.reply.informationId,
        },
      ]);
      expect(completed.references).toContainEqual({
        relation: "core:caused-by",
        informationId: requested.informationId,
      });
      expect(completed.references).toContainEqual({
        relation: "core:status-of",
        informationId: requested.informationId,
      });
      expect(completed.references).toContainEqual({
        relation: "core:context",
        informationId: fixture.context.informationId,
      });
      expect(completed.payload).toMatchObject({
        output: { text: "Moonlight." },
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        durationMs: 25,
        reply: fixture.reply.payload,
      });

      for (const atom of lifecycleAtoms) {
        const definition = builtInInformationKinds.find(
          ({ kind }) => kind === atom.kind,
        )!;
        expect(definition.log.enabled).toBe(true);
        if (definition.log.enabled) {
          const serialized = JSON.stringify(
            definition.log.project(atom as never),
          );
          expect(serialized).not.toMatch(
            /never-log-this|postgresql:\/\/secret|prompt|response|credential/i,
          );
        }
      }

      await fixture.core.close();
      await fixture.database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects Prompt provenance that differs from selected context order",
    async () => {
      const fixture = await createFixture(
        createRepeatingDeterministicModel({ text: "unused" }),
      );
      const prompt = tracedPrompt([
        fixture.reply.informationId,
        fixture.memory.informationId,
      ]);

      await expect(
        fixture.lifecycle.generate(
          lifecycleRequest(
            prompt,
            [fixture.memory, fixture.reply],
            fixture.reply,
          ),
          fixture.context,
          fixture.reply,
        ),
      ).rejects.toThrow(
        "Prompt provenance must match selected information order",
      );
      expect(
        await llmRequestedAtoms(fixture.database, fixture.context),
      ).toEqual([]);
      await fixture.core.close();
      await fixture.database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects selected context that omits the caused-by reply",
    async () => {
      const fixture = await createFixture(
        createRepeatingDeterministicModel({ text: "unused" }),
      );
      const prompt = tracedPrompt([fixture.memory.informationId]);

      await expect(
        fixture.lifecycle.generate(
          lifecycleRequest(prompt, [fixture.memory], fixture.reply),
          fixture.context,
          fixture.reply,
        ),
      ).rejects.toThrow("Selected information must include the reply source");
      expect(
        await llmRequestedAtoms(fixture.database, fixture.context),
      ).toEqual([]);
      await fixture.core.close();
      await fixture.database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "registers failed before rethrowing the classified LLM error",
    async () => {
      const fixture = await createFixture(
        createRepeatingDeterministicModel({ text: "" }),
      );

      const caught = await fixture.lifecycle
        .generate(
          lifecycleRequest(
            tracedPrompt([fixture.reply.informationId]),
            [fixture.reply],
            fixture.reply,
          ),
          fixture.context,
          fixture.reply,
        )
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(KaguyaLlmError);
      expect(caught).toMatchObject({ kind: "non-retryable" });
      const observed = await fixture.database.information.query({
        informationId: fixture.context.informationId,
      });
      expect(
        observed
          .filter(({ kind }) => kind.startsWith("core.llm."))
          .map(({ kind }) => kind),
      ).toEqual(["core.llm.requested", "core.llm.failed"]);
      const requested = observed.find(
        ({ kind }) => kind === "core.llm.requested",
      )!;
      const failed = observed.find(({ kind }) => kind === "core.llm.failed")!;
      expect(failed.references).toEqual([
        { relation: "core:caused-by", informationId: requested.informationId },
        { relation: "core:status-of", informationId: requested.informationId },
        {
          relation: "core:context",
          informationId: fixture.context.informationId,
        },
      ]);
      expect(failed.payload).toMatchObject({
        error: {
          name: "KaguyaLlmError",
          kind: "non-retryable",
          message: "Language model generation failed",
        },
      });

      await fixture.core.close();
      await fixture.database.close();
    },
    TEST_TIMEOUT,
  );

  it.each(["retryable", "cancelled"] as const)(
    "persists a %s generation failure fact",
    async (kind) => {
      const classified = new KaguyaLlmError("provider failure", {
        kind,
        cause: new Error("provider failure"),
      });
      const fixture = await createFixture(
        createRepeatingDeterministicModel({ text: "unused" }),
        {
          generate: async () => Promise.reject(classified),
        } as unknown as KaguyaLlmClient,
      );

      await expect(
        fixture.lifecycle.generate(
          lifecycleRequest(
            tracedPrompt([fixture.reply.informationId]),
            [fixture.reply],
            fixture.reply,
          ),
          fixture.context,
          fixture.reply,
        ),
      ).rejects.toMatchObject({ kind });

      const observed = await fixture.database.information.query({
        informationId: fixture.context.informationId,
      });
      expect(
        observed.find(({ kind: atomKind }) => atomKind === "core.llm.failed")
          ?.payload,
      ).toMatchObject({ error: { kind } });
      await fixture.core.close();
      await fixture.database.close();
    },
    TEST_TIMEOUT,
  );
});
