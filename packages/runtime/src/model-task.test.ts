/**
 * 功能概述：用真实 Core/PGlite 验证通用 Model Task 的身份、输出校验和唯一终态。
 * 主要职责：fixture 创建隔离账本；用不同任务 schema 检查去重、预检、取消及 claim fencing。
 * 代码库关系：消费 model-task 与 information-kinds；transform 测试组合真实 KaguyaLlmClient
 * 与内存 provider，其余并发场景以可控 generate 替身隔离外部调用。
 * 输入输出与副作用：只写测试数据库；敏感字符串是泄漏探针；每例关闭 Core 与数据库。
 */
import { createTestingDatabase } from "@kaguya/database/testing";
import { InformationCore, InformationKindRegistry } from "@kaguya/engine";
import { KaguyaLlmClient } from "@kaguya/llm/client";
import { createRepeatingDeterministicModel } from "@kaguya/llm/testing";
import { PromptCompiler } from "@kaguya/prompt";
import { z } from "@kaguya/schema";
import {
  defineInformationKind,
  type ModuleCapabilityImplementation,
} from "@kaguya/sdk";
import { afterEach, expect, it, vi } from "vitest";
import {
  ModelTaskClient,
  modelTaskCapability,
  type ModelTaskCapability,
} from "./model-task.js";
import {
  modelTaskInformationKinds,
  runtimeContextInformationKind,
} from "./information-kinds.js";

const secret = "credential=secret postgresql://private";
const sourceKind = defineInformationKind({
  kind: "test.input",
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

async function fixture(durable = false) {
  const db = await createTestingDatabase();
  cleanups.push(() => db.close());
  await db.migrate();
  const registry = new InformationKindRegistry();
  registry.registerBuiltin(runtimeContextInformationKind);
  for (const kind of modelTaskInformationKinds) registry.registerBuiltin(kind);
  registry.register(sourceKind);
  let id = 0;
  const core = new InformationCore({
    registry,
    store: db.information,
    nextInformationId: () => `task-${++id}`,
  });
  await core.start();
  if (durable)
    await db.information.reliable.configureSubscriptions([
      { subscriptionId: "test.task", kind: sourceKind.kind },
    ]);
  cleanups.push(() => core.close());
  const input = {
    occurredAt: "2026-09-06T00:00:00.000Z",
    source: "test:fixture",
    references: [],
  };
  const context = await core.register(runtimeContextInformationKind, {
    ...input,
    payload: {},
  });
  const source = await core.register(sourceKind, {
    ...input,
    payload: { text: secret },
    references: [
      { relation: "core:context", informationId: context.informationId },
    ],
  });
  const second = await core.register(sourceKind, {
    ...input,
    payload: { text: "second" },
    references: source.references,
  });
  const prompt = new PromptCompiler().compile(
    "reply",
    [source, second].map((atom, i) => ({
      id: `fragment-${i}`,
      informationId: atom.informationId,
      source: "history" as const,
      priority: i,
      content: atom.payload.text,
      metadata: {},
    })),
  );
  const generate = vi.fn().mockResolvedValue({
    output: { text: "hello" },
    usage: { totalTokens: 7 },
    durationMs: 5,
  });
  const options = {
    core,
    client: { generate } as Pick<KaguyaLlmClient, "generate">,
    resolveModel: () => ({ providerId: "test", modelId: "test-heavy" }),
  };
  const client = new ModelTaskClient(options);
  const request = {
    task: {
      taskId: "test.reply",
      version: "1",
      outputSchema: z.object({ text: z.string() }).strict(),
      allowedTiers: ["heavy"] as const,
    },
    sourceInformationId: source.informationId,
    contextInformationId: context.informationId,
    activation: { instanceId: "test.one", definitionId: "test.module" },
    selectionPolicy: { tier: "heavy" as const },
    prompt,
    contextAtoms: [source, second],
  };
  const atoms = () => core.query({ informationId: context.informationId });
  return { db, core, client, options, request, generate, atoms, source };
}

it("reuses requested identity across instances and canonical key order, with only one provider call on replay", async () => {
  const f = await fixture();
  const provision: ModuleCapabilityImplementation<ModelTaskCapability> = {
    capability: modelTaskCapability,
    value: f.client,
  };
  const first = await provision.value.execute(f.request);
  const second = await new ModelTaskClient(f.options).execute({
    ...f.request,
    activation: { definitionId: "test.module", instanceId: "test.two" },
    prompt: {
      ...f.request.prompt,
      text: "excluded from fingerprint",
      provenance: f.request.prompt.provenance.map((p) => ({
        contentDigest: p.contentDigest,
        priority: p.priority,
        source: p.source,
        informationId: p.informationId!,
        fragmentId: p.fragmentId,
      })),
    },
  });
  expect(first).toEqual(second);
  expect(first.status).toBe("completed");
  if (first.status === "completed")
    expect(first.output).toEqual({ text: "hello" });
  expect(f.generate).toHaveBeenCalledTimes(1);
  const atoms = await f.atoms();
  expect(
    atoms.filter((a) => a.kind === "core.model.task.requested"),
  ).toHaveLength(1);
  const requested = atoms.find((a) => a.kind === "core.model.task.requested")!;
  expect(requested.payload).toMatchObject({
    taskId: "test.reply",
    version: "1",
    activation: f.request.activation,
    selectionPolicy: { tier: "heavy" },
    resolvedModel: { providerId: "test", modelId: "test-heavy" },
    prompt: { provenance: f.request.prompt.provenance },
  });
  expect(
    requested.references
      .filter((r) => r.relation === "core:uses-context")
      .map((r) => r.informationId),
  ).toEqual(f.request.contextAtoms.map((a) => a.informationId));
  expect(
    atoms.find((a) => a.kind === "core.model.task.completed")!.payload,
  ).toMatchObject({ usage: { totalTokens: 7 }, durationMs: 5 });
});

it("exposes the agreed capability identity", () => {
  expect(modelTaskCapability.id).toBe("kaguya:model-task");
  expect(modelTaskCapability.apiVersion).toBe(1);
});

it.each(["completed", "failed", "cancelled"])(
  "replays %s without resolving an unavailable model",
  async (status) => {
    const f = await fixture();
    if (status === "failed") f.generate.mockRejectedValue(new Error(secret));
    if (status === "cancelled")
      f.generate.mockImplementationOnce(async () => {
        const requested = (await f.atoms()).find(
          (a) => a.kind === "core.model.task.requested",
        )!;
        await f.client.cancel({
          requestedInformationId: requested.informationId,
          reason: "stop",
        });
        return { output: { text: "late" }, durationMs: 1 };
      });
    const winner = await f.client.execute(f.request);
    expect(winner.status).toBe(status);
    const resolveModel = vi.fn(() => {
      throw new Error(secret);
    });
    const replay = new ModelTaskClient({ ...f.options, resolveModel });
    expect(await replay.execute(f.request)).toEqual(winner);
    expect(resolveModel).not.toHaveBeenCalled();
    expect(f.generate).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  "handles ledger-rejected output safely with cancellation winner=%s",
  async (cancelled) => {
    const f = await fixture();
    f.generate.mockImplementation(async () => {
      if (cancelled) {
        const requested = (await f.atoms()).find(
          (a) => a.kind === "core.model.task.requested",
        )!;
        await f.client.cancel({
          requestedInformationId: requested.informationId,
          reason: "stop",
        });
      }
      return { output: { profileId: "x" }, durationMs: 1 };
    });
    const result = await f.client.execute({
      ...f.request,
      task: {
        ...f.request.task,
        outputSchema: z.object({ profileId: z.string() }).strict(),
      },
    });
    expect(result.status).toBe(cancelled ? "cancelled" : "failed");
    const terminals = (await f.atoms()).filter(
      (a) =>
        a.kind.startsWith("core.model.task.") &&
        a.kind !== "core.model.task.requested",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.payload).not.toHaveProperty("output");
    expect(JSON.stringify(result)).not.toContain("profileId");
  },
);

it.each(["suffix", "shape"])(
  "runs a %s transform once with the real provider client and replays the persisted output",
  async (mode) => {
    const f = await fixture();
    let transforms = 0;
    const outputSchema = z
      .object({ text: z.string() })
      .strict()
      .transform((value) => {
        transforms++;
        return mode === "suffix"
          ? { text: value.text + "!" }
          : { length: value.text.length };
      });
    const model = createRepeatingDeterministicModel({ text: "hello" });
    const client = new ModelTaskClient({
      ...f.options,
      client: new KaguyaLlmClient({ model }),
    });
    const request = { ...f.request, task: { ...f.request.task, outputSchema } };
    const first = await client.execute(request);
    expect(first.status).toBe("completed");
    if (first.status === "completed")
      expect(first.output).toEqual(
        mode === "suffix" ? { text: "hello!" } : { length: 5 },
      );
    expect(await client.execute(request)).toEqual(first);
    expect(transforms).toBe(1);
    expect(model.doGenerateCalls).toHaveLength(1);
    const completed = (await f.atoms()).find(
      (a) => a.kind === "core.model.task.completed",
    )!;
    expect(completed.payload.output).toEqual(
      mode === "suffix" ? { text: "hello!" } : { length: 5 },
    );
  },
);

it("does not turn terminal storage errors into business failure", async () => {
  const f = await fixture();
  const append = vi
    .spyOn(f.db.information.reliable, "appendTerminal")
    .mockRejectedValue(new Error(secret));
  try {
    await expect(f.client.execute(f.request)).rejects.toThrow(
      "Model task execution could not be committed",
    );
    expect(append).toHaveBeenCalledTimes(1);
    expect(
      (await f.atoms())
        .filter((a) => a.kind.startsWith("core.model.task."))
        .map((a) => a.kind),
    ).toEqual(["core.model.task.requested"]);
  } finally {
    append.mockRestore();
  }
});

it("does not copy ledger-rejected usage into the safe failed payload", async () => {
  const f = await fixture();
  f.generate.mockResolvedValue({
    output: { text: "ok" },
    usage: { profileId: 1 },
    durationMs: 1,
  });
  const result = await f.client.execute(f.request);
  expect(result.status).toBe("failed");
  const failed = (await f.atoms()).find(
    (a) => a.kind === "core.model.task.failed",
  )!;
  expect(failed.payload).not.toHaveProperty("usage");
  expect(failed.payload).not.toHaveProperty("output");
});

it("supports a non-reply task-owned schema without a central business union", async () => {
  const f = await fixture();
  f.generate.mockResolvedValue({
    output: { facts: [{ subject: "Ada", fact: "likes tea" }] },
    durationMs: 2,
  });
  const result = await f.client.execute({
    ...f.request,
    task: {
      ...f.request.task,
      taskId: "test.person-fact",
      outputSchema: z
        .object({
          facts: z.array(
            z.object({ subject: z.string(), fact: z.string() }).strict(),
          ),
        })
        .strict(),
    },
    prompt: { ...f.request.prompt, kind: "memory" },
  });
  expect(result.status).toBe("completed");
  if (result.status === "completed")
    expect(result.output.facts[0]?.fact).toBe("likes tea");
});

it.each([
  "order",
  "digest",
  "fragment",
  "forged-atom",
  "missing-atom",
  "tier",
  "task",
  "schema",
])("rejects %s before persistence or provider", async (mode) => {
  const f = await fixture();
  const request = structuredClone({
    ...f.request,
    task: { ...f.request.task, outputSchema: undefined },
  });
  const changed = { ...request, task: { ...f.request.task } };
  if (mode === "order") changed.contextAtoms.reverse();
  if (mode === "digest") changed.prompt.provenance[0]!.contentDigest = "forged";
  if (mode === "fragment") changed.prompt.provenance[0]!.fragmentId = "forged";
  if (mode === "forged-atom")
    changed.contextAtoms[0] = {
      ...changed.contextAtoms[0]!,
      payload: { text: "forged" },
    };
  if (mode === "missing-atom")
    changed.contextAtoms[0] = {
      ...changed.contextAtoms[0]!,
      informationId: "missing",
    };
  if (mode === "tier") changed.selectionPolicy.tier = "light" as never;
  if (mode === "task") changed.task.taskId = "";
  if (mode === "schema") changed.task.outputSchema = undefined as never;
  await expect(f.client.execute(changed)).rejects.toThrow();
  expect(f.generate).not.toHaveBeenCalled();
  expect(
    (await f.atoms()).filter((a) => a.kind.startsWith("core.model.task.")),
  ).toEqual([]);
});

it.each(["schema", "provider"])(
  "persists safe failed terminal for %s errors without output or secret",
  async (mode) => {
    const f = await fixture();
    if (mode === "schema")
      f.generate.mockResolvedValue({ output: { bad: secret }, durationMs: 3 });
    else
      f.generate.mockRejectedValue(
        Object.assign(new Error(secret), { name: secret }),
      );
    const result = await f.client.execute(f.request);
    expect(result.status).toBe("failed");
    expect(result).not.toHaveProperty("output");
    const failed = (await f.atoms()).find(
      (a) => a.kind === "core.model.task.failed",
    )!;
    expect(failed.payload).not.toHaveProperty("output");
    expect(JSON.stringify(failed.payload.error)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain(secret);
    for (const atom of await f.atoms()) {
      const kind = modelTaskInformationKinds.find((k) => k.kind === atom.kind);
      if (kind?.log.enabled)
        expect(JSON.stringify(kind.log.project!(atom as never))).not.toContain(
          secret,
        );
    }
    expect(await f.client.execute(f.request)).toEqual(result);
    expect(f.generate).toHaveBeenCalledTimes(1);
  },
);

it.each(["completed", "failed", "cancelled"])(
  "returns the %s winner to concurrent losers in the same terminal group",
  async (winner) => {
    const f = await fixture();
    let finish!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    f.generate.mockImplementationOnce(
      () =>
        new Promise((resolve, fail) => {
          finish = resolve;
          reject = fail;
        }),
    );
    const slow = f.client.execute(f.request);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    const requested = (await f.atoms()).find(
      (a) => a.kind === "core.model.task.requested",
    )!;
    let chosen;
    if (winner === "cancelled")
      chosen = await f.client.cancel({
        requestedInformationId: requested.informationId,
        reason: secret,
      });
    else {
      if (winner === "failed")
        f.generate.mockRejectedValueOnce(new Error(secret));
      chosen = await new ModelTaskClient(f.options).execute(f.request);
    }
    expect(chosen.status).toBe(winner);
    if (winner === "completed") reject(new Error(secret));
    else finish({ output: { text: "late" }, durationMs: 1 });
    expect(await slow).toEqual(chosen);
    expect(
      await f.client.cancel({
        requestedInformationId: requested.informationId,
        reason: "later",
      }),
    ).toEqual(chosen);
    const terminals = (await f.atoms()).filter((a) =>
      [
        "core.model.task.completed",
        "core.model.task.failed",
        "core.model.task.cancelled",
      ].includes(a.kind),
    );
    expect(terminals).toHaveLength(1);
    expect(JSON.stringify(chosen)).not.toContain(secret);
  },
);

it.each(["abort", "lease"])(
  "does not commit business cancelled or late completion after %s loss",
  async (mode) => {
    const f = await fixture(true);
    const reliable = f.db.information.reliable!;
    const claim = (await reliable.claim("test.task", 60_000))!;
    expect(claim.informationId).toBe(f.source.informationId);
    const controller = new AbortController();
    let finish!: (value: unknown) => void;
    f.generate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.core.withClaim(claim, controller.signal, () =>
      f.client.execute(f.request),
    );
    const rejection = pending.catch((error) => error as Error);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledTimes(1));
    expect(f.generate.mock.calls[0]![0].signal).toBe(controller.signal);
    if (mode === "abort") controller.abort(new Error(secret));
    else await reliable.release(claim);
    finish({ output: { text: "late" }, durationMs: 1 });
    expect(await rejection).toBeInstanceOf(Error);
    expect(String(await rejection)).not.toContain(secret);
    expect(
      (await f.atoms())
        .filter((a) => a.kind.startsWith("core.model.task."))
        .map((a) => a.kind),
    ).toEqual(["core.model.task.requested"]);
  },
);

it("treats a provider AbortError as safe failed, never explicit cancelled", async () => {
  const f = await fixture();
  f.generate.mockRejectedValue(
    Object.assign(new Error(secret), { name: "AbortError" }),
  );
  expect((await f.client.execute(f.request)).status).toBe("failed");
  expect(
    (await f.atoms()).some((a) => a.kind === "core.model.task.cancelled"),
  ).toBe(false);
});

it("retains validated usage and duration when output schema rejects provider data", async () => {
  const f = await fixture();
  f.generate.mockResolvedValue({
    output: { bad: secret },
    usage: { totalTokens: 19 },
    durationMs: 42,
  });
  await f.client.execute(f.request);
  const failed = (await f.atoms()).find(
    (a) => a.kind === "core.model.task.failed",
  )!;
  expect(failed.payload).toMatchObject({
    usage: { totalTokens: 19 },
    durationMs: 42,
  });
  expect(failed.payload).not.toHaveProperty("output");
});

it("returns the persisted winner output without applying a transform again", async () => {
  const f = await fixture();
  const request = {
    ...f.request,
    task: {
      ...f.request.task,
      outputSchema: z
        .object({ text: z.string() })
        .transform((value) => ({ text: value.text + "!" })),
    },
  };
  const first = await f.client.execute(request);
  const terminal = (await f.atoms()).find(
    (a) => a.kind === "core.model.task.completed",
  )!;
  expect(first.status).toBe("completed");
  if (first.status === "completed")
    expect(first.output).toEqual(terminal.payload.output);
  expect(await f.client.execute(request)).toEqual(first);
});

it.each(["task", "version", "source", "kind", "digest", "order", "policy"])(
  "includes %s in the fingerprint",
  async (mode) => {
    const f = await fixture();
    const first = await f.client.execute(f.request);
    const changed = {
      ...f.request,
      selectionPolicy: {
        tier: f.request.selectionPolicy.tier as "light" | "heavy",
      },
      task: { ...f.request.task, allowedTiers: ["light", "heavy"] as const },
    };
    if (mode === "task") changed.task.taskId = "test.another";
    if (mode === "version") changed.task.version = "2";
    if (mode === "source")
      changed.sourceInformationId = f.request.contextAtoms[1]!.informationId;
    if (mode === "kind") changed.prompt = { ...changed.prompt, kind: "memory" };
    if (mode === "policy") changed.selectionPolicy = { tier: "light" };
    if (mode === "digest")
      changed.prompt = new PromptCompiler().compile(
        "reply",
        changed.prompt.fragments.map((f) => ({
          ...f,
          content: f.content + "changed renderer",
        })),
      );
    if (mode === "order") {
      changed.contextAtoms = [...changed.contextAtoms].reverse();
      changed.prompt = new PromptCompiler().compile(
        "reply",
        [...changed.prompt.fragments]
          .reverse()
          .map((f, priority) => ({ ...f, priority })),
      );
    }
    const second = await f.client.execute(changed);
    expect(first.requestedInformationId).not.toBe(
      second.requestedInformationId,
    );
    expect(
      (await f.atoms()).filter((a) => a.kind === "core.model.task.requested"),
    ).toHaveLength(2);
  },
);
