/**
 * 测试配置分别声明 inboundAllowlist/outboundAllowlist，保持与严格 Profile 或 Runtime 出站策略契约一致。
 * 功能概述：使用真实 PGlite/Runtime/Composer 验证管理端跨会话授权及投递终检。
 * 主要职责：覆盖目录解析、两次确认、上下文隔离、伪造目的地、断线代次和失败 turn；所有平台 I/O 使用 spy。
 * 代码库关系：正式 composition 提供确定性模型，MessageTargetService 使用假目录，账本保持真实持久化与 durable 消费。
 * 输入输出与副作用：每例独立内存数据库，测试后关闭 Runtime；不调用真实模型或 QQ。
 */
import { AdapterHost } from "./adapter-host.js";
import { Writable } from "node:stream";
import { createLogger, closeLogger } from "@kaguya/logger";
import { createMessageComposition } from "@kaguya/composition";
import { createTestingDatabase } from "@kaguya/database/testing";
import {
  createFirstPartyModuleConfigDefaults,
  deliveryRequestedInformationKind,
} from "@kaguya/modules";
import {
  KaguyaRuntime,
  GatewayAllowlist,
  type RuntimeCapabilityContext,
} from "@kaguya/runtime";
import type {
  ReachableTarget,
  PlatformMessageTarget,
} from "@kaguya/platform-adapters";
import { afterEach, expect, it, vi } from "vitest";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(
  outboundRules = ["qq:group:100", "qq:group:300", "qq:private:200"],
  inboundRules: string[] = [],
) {
  const database = await createTestingDatabase();
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      logs.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({
    service: "target-test",
    level: "info",
    stream,
  });
  let generation = "account-a:connection-1";
  let unavailable = false;
  const candidates: ReachableTarget[] = [
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group", groupId: "100" },
      name: "研究组",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "private", userId: "200" },
      name: "同事",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group", groupId: "300" },
      name: "同事",
    },
    {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group", groupId: "999" },
      name: "未授权",
    },
  ];
  const composition = createMessageComposition(undefined, {
    moduleConfigs: createFirstPartyModuleConfigDefaults("test"),
  });
  let core!: RuntimeCapabilityContext["core"];
  const policy = new GatewayAllowlist(outboundRules);
  const runtime = new KaguyaRuntime({
    ...composition,
    database,
    logger,
    outboundAllowlist: policy,
    targetDirectory: {
      listTargets: async () => {
        if (unavailable) throw new Error("secret-directory-response");
        return { generation, candidates };
      },
    },
    capabilities: (c) => {
      core = c.core;
      return composition.capabilities(c);
    },
  });
  const host = new AdapterHost(logger, inboundRules);
  host.finalizeRuntime(runtime);
  const send = vi.fn(async (target: PlatformMessageTarget) => ({
    ok: true as const,
    adapterId: "test",
    platform: "qq" as const,
    target,
  }));
  runtime.registerTransport({
    adapterId: "test",
    platform: "qq",
    transport: { sendMessage: send },
  });
  runtime.registerTransport({
    adapterId: "web.ui.main",
    platform: "web",
    transport: {
      sendMessage: async (target) => ({
        ok: true,
        adapterId: "web.ui.main",
        platform: "web",
        target,
      }),
    },
  });
  await runtime.start();
  cleanups.push(async () => {
    await runtime.close();
    await database.close();
    await closeLogger(logger);
  });
  const atoms = () =>
    database.information.find({
      occurredAfter: "2020-01-01T00:00:00.000Z",
      order: "asc",
      limit: 1000,
    });
  const settle = () =>
    vi.waitFor(
      async () =>
        expect((await database.information.reliable.health()).pending).toBe(0),
      { timeout: 8000, interval: 20 },
    );
  await runtime.submit({
    adapterId: "web.ui.main",
    platform: "web",
    platformMessageId: "source",
    occurredAt: new Date().toISOString(),
    text: "private-source-do-not-disclose",
    mentions: [],
    sender: { userId: "admin" },
    target: { kind: "web" },
    raw: {},
  });
  await settle();
  const turn = (await atoms()).find(
    (a) => a.kind === "agent.turn.context.completed",
  )!;
  expect(turn).toBeDefined();
  const restart = async () => {
    await runtime.close();
    const next = new KaguyaRuntime({
      ...composition,
      database,
      outboundAllowlist: new GatewayAllowlist([]),
      targetDirectory: {
        listTargets: async () => ({ generation, candidates }),
      },
      capabilities: (c) => {
        core = c.core;
        return composition.capabilities(c);
      },
    });
    next.registerTransport({
      adapterId: "test",
      platform: "qq",
      transport: { sendMessage: send },
    });
    await next.start();
    cleanups.push(() => next.close());
    return next;
  };
  return {
    logs,
    host,
    restart,
    getCore: () => core,
    runtime,
    service: runtime.messageTargets!,
    atoms,
    settle,
    send,
    core,
    turn,
    policy,
    disconnect: () => {
      unavailable = true;
    },
    reconnect: () => {
      generation = "account-b:connection-2";
    },
  };
}
it.each(["100", "200"])(
  "resolves and sends %s only after target and content confirmation",
  async (id) => {
    const f = await fixture();
    expect(
      f.host.acceptInbound({
        adapterId: "test",
        platform: "qq",
        platformMessageId: "denied",
        occurredAt: new Date().toISOString(),
        text: "test",
        mentions: [],
        sender: { userId: id },
        raw: {},
        target:
          id === "100"
            ? { kind: "group", groupId: id }
            : { kind: "private", userId: id },
      }),
    ).toBe(false);
    expect(await f.service.resolve({ mode: "name", value: "missing" })).toEqual(
      { status: "not-found" },
    );
    expect(await f.service.resolve({ mode: "name", value: "未授权" })).toEqual({
      status: "unauthorized",
    });
    expect(
      (await f.service.resolve({ mode: "name", value: "同事" })).status,
    ).toBe("ambiguous");
    expect(
      (await f.service.resolve({ mode: "description", value: "发到研究组" }))
        .status,
    ).toBe("ambiguous");
    const result = await f.service.resolve({ mode: "id", value: id });
    expect(result.status).toBe("resolved");
    if (!("candidates" in result)) throw new Error("expected candidates");
    const approved = await f.service.authorize({
      reference: result.candidates[0]!.reference,
      sourceTurnContextInformationId: f.turn.informationId,
      instruction: "请告知会议改到下午三点。",
    });
    expect(approved.status).toBe("confirmation-required");
    if (!("requestId" in approved)) throw new Error("expected request");
    await f.settle();
    const status = await f.service.status(approved.requestId);
    expect(status.status).toBe("confirmation-required");
    expect(f.send).not.toHaveBeenCalled();
    const graph = await f.atoms();
    const intent = graph.find(
      (a) => a.informationId === approved.intentInformationId,
    )!;
    const requests = graph.filter(
      (a) =>
        a.kind === "core.model.task.requested" &&
        a.payload.sourceInformationId === intent.informationId,
    );
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(requests[0]!.payload.prompt)).toContain(
      "会议改到下午三点",
    );
    expect(JSON.stringify(requests[0]!.payload.prompt)).not.toContain(
      "private-source-do-not-disclose",
    );
    if (
      !("assistantInformationId" in status) ||
      !status.assistantInformationId ||
      !status.text
    )
      throw new Error("missing text");
    expect(
      await f.service.confirm(
        approved.requestId,
        status.assistantInformationId,
        "tampered",
      ),
    ).toEqual({ status: "conflict" });
    expect(
      await f.service.confirm(
        approved.requestId,
        status.assistantInformationId,
        status.text,
      ),
    ).toEqual({ status: "confirmed" });
    await f.settle();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![0]).toEqual(
      id === "100"
        ? { kind: "group", groupId: "100" }
        : { kind: "private", userId: "200" },
    );
    expect(
      (await f.atoms()).some(
        (a) =>
          a.kind === "agent.turn.completed" &&
          a.payload.candidateInformationId ===
            (intent.payload.turn as { candidateInformationId: string })
              .candidateInformationId,
      ),
    ).toBe(true);
    expect(
      await f.service.confirm(
        approved.requestId,
        status.assistantInformationId,
        status.text,
      ),
    ).toEqual({ status: "conflict" });
  },
  20000,
);
it("invalidates candidates on reconnect and returns unavailable on directory failure", async () => {
  const f = await fixture();
  const result = await f.service.resolve({ mode: "id", value: "200" });
  if (!("candidates" in result)) throw new Error("expected candidates");
  f.reconnect();
  expect(
    await f.service.authorize({
      reference: result.candidates[0]!.reference,
      sourceTurnContextInformationId: f.turn.informationId,
      instruction: "hello",
    }),
  ).toEqual({ status: "expired" });
  f.disconnect();
  expect(await f.service.resolve({ mode: "id", value: "200" })).toEqual({
    status: "unavailable",
  });
  expect(f.send).not.toHaveBeenCalled();
}, 20000);
it("blocks forged final destinations with a redacted failure and closes the isolated turn", async () => {
  const f = await fixture();
  const result = await f.service.resolve({ mode: "id", value: "200" });
  if (!("candidates" in result)) throw new Error("expected candidates");
  const approved = await f.service.authorize({
    reference: result.candidates[0]!.reference,
    sourceTurnContextInformationId: f.turn.informationId,
    instruction: "approved",
  });
  if (!("requestId" in approved)) throw new Error("expected request");
  await f.settle();
  const status = await f.service.status(approved.requestId);
  if (!("assistantInformationId" in status) || !status.assistantInformationId)
    throw new Error("missing assistant");
  const assistant = await f.service.read(status.assistantInformationId);
  const request = await f.core.register(deliveryRequestedInformationKind, {
    source: "test:incorrect-module",
    occurredAt: new Date().toISOString(),
    payload: {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "group", groupId: "999" },
      message: { kind: "text", text: "secret-message" },
      turn: assistant.payload.turn as never,
    },
    references: [
      { relation: "core:caused-by", informationId: assistant.informationId },
      ...assistant.references.filter((r) => r.relation === "core:context"),
    ],
  });
  await f.settle();
  expect(f.send).not.toHaveBeenCalled();
  const graph = await f.atoms();
  const failure = graph.find(
    (a) =>
      a.kind === "core.delivery.failed" &&
      a.references.some((r) => r.informationId === request.informationId),
  )!;
  expect(failure.payload).toEqual({
    ok: false,
    adapterId: "test",
    platform: "qq",
    targetKind: "group",
    error: "destination-not-allowed",
  });
  expect(JSON.stringify(failure.payload)).not.toContain("999");
  expect(JSON.stringify(failure)).not.toContain("secret-message");
  await vi.waitFor(() =>
    expect(f.logs.join("")).toContain("destination-not-allowed"),
  );
  const rejectionLogs = f.logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.errorType === "destination-not-allowed");
  expect(rejectionLogs.length).toBeGreaterThan(0);
  for (const line of rejectionLogs) {
    expect(line).toMatchObject({
      platform: "qq",
      adapterId: "test",
      targetKind: "group",
    });
    expect(line).not.toHaveProperty("target");
    expect(line).not.toHaveProperty("destination");
    expect(JSON.stringify(line)).not.toContain("secret-message");
  }
  expect(f.logs.join("")).not.toContain("secret-message");
  expect(
    graph.some(
      (a) =>
        a.kind === "agent.turn.failed" &&
        a.payload.candidateInformationId ===
          (assistant.payload.turn as { candidateInformationId: string })
            .candidateInformationId,
    ),
  ).toBe(true);
}, 20000);

it("rechecks tightened policy after Runtime replacement and rejects old approvals", async () => {
  const f = await fixture();
  const result = await f.service.resolve({ mode: "id", value: "200" });
  if (!("candidates" in result)) throw new Error("missing candidates");
  const approved = await f.service.authorize({
    reference: result.candidates[0]!.reference,
    sourceTurnContextInformationId: f.turn.informationId,
    instruction: "approved",
  });
  if (!("requestId" in approved)) throw new Error("missing request");
  await f.settle();
  const status = await f.service.status(approved.requestId);
  if (!("assistantInformationId" in status) || !status.assistantInformationId)
    throw new Error("missing assistant");
  const assistant = await f.service.read(status.assistantInformationId);
  const next = await f.restart();
  expect(await next.messageTargets!.status(approved.requestId)).toEqual({
    status: "expired",
  });
  const request = await f.getCore().register(deliveryRequestedInformationKind, {
    source: "test:replay",
    occurredAt: new Date().toISOString(),
    payload: {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "private", userId: "200" },
      message: { kind: "text", text: String(assistant.payload.text) },
      turn: assistant.payload.turn as never,
    },
    references: [
      { relation: "core:caused-by", informationId: assistant.informationId },
      ...assistant.references.filter((r) => r.relation === "core:context"),
    ],
  });
  await f.settle();
  expect(f.send).not.toHaveBeenCalled();
  expect(
    (await f.atoms()).find(
      (a) =>
        a.kind === "core.delivery.failed" &&
        a.references.some((r) => r.informationId === request.informationId),
    )?.payload.error,
  ).toBe("destination-not-allowed");
}, 20000);
it("blocks an allowlisted forged delivery before content confirmation", async () => {
  const f = await fixture();
  const result = await f.service.resolve({ mode: "id", value: "200" });
  if (!("candidates" in result)) throw new Error("missing candidates");
  const approved = await f.service.authorize({
    reference: result.candidates[0]!.reference,
    sourceTurnContextInformationId: f.turn.informationId,
    instruction: "approved",
  });
  if (!("requestId" in approved)) throw new Error("missing request");
  await f.settle();
  const status = await f.service.status(approved.requestId);
  if (!("assistantInformationId" in status) || !status.assistantInformationId)
    throw new Error("missing assistant");
  const assistant = await f.service.read(status.assistantInformationId);
  const request = await f.core.register(deliveryRequestedInformationKind, {
    source: "test:incorrect-module",
    occurredAt: new Date().toISOString(),
    payload: {
      adapterId: "test",
      platform: "qq",
      destination: { kind: "private", userId: "200" },
      message: { kind: "text", text: String(assistant.payload.text) },
      turn: assistant.payload.turn as never,
    },
    references: [
      { relation: "core:caused-by", informationId: assistant.informationId },
      ...assistant.references.filter((r) => r.relation === "core:context"),
    ],
  });
  await f.settle();
  expect(f.send).not.toHaveBeenCalled();
  expect(
    (await f.atoms()).find(
      (a) =>
        a.kind === "core.delivery.failed" &&
        a.references.some((r) => r.informationId === request.informationId),
    )?.payload.error,
  ).toBe("target-authorization-required");
}, 20000);

it.each(["group", "private"] as const)(
  "accepts %s ingress while empty outbound policy prevents replies",
  async (kind) => {
    const f = await fixture([], ["*:group:*", "*:private:*"]);
    await f.host.ingress.submit({
      adapterId: "test",
      platform: "qq",
      platformMessageId: "accepted",
      occurredAt: new Date().toISOString(),
      text: "请回复测试消息",
      selfId: "998877",
      mentions: [{ kind: "user", id: "998877" }],
      sender: { userId: "200" },
      raw: {},
      target:
        kind === "group"
          ? { kind: "group", groupId: "100" }
          : { kind: "private", userId: "200" },
    });
    await f.settle();
    const graph = await f.atoms();
    expect(
      graph.some(
        (a) =>
          a.kind === "core.message.inbound.text" &&
          a.payload.text === "请回复测试消息",
      ),
    ).toBe(true);
    expect(
      graph.some(
        (a) =>
          a.kind === "core.delivery.failed" &&
          a.payload.error === "destination-not-allowed" &&
          a.payload.targetKind === kind,
      ),
    ).toBe(true);
    expect(f.send).not.toHaveBeenCalled();
  },
  20000,
);
