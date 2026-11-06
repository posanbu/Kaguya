/**
 * 功能概述：验证 W3 ActionExecution 到 Linux broker 的身份、控制租约和凭证边界。
 * 主要职责：受控 transport 记录实际发送内容，覆盖新租约核对旧 attempt、取消成功回执保留、
 * 参数不一致和秘密结果拒绝；领取/续租身份不符与未确认释放均不得丢失既有清理凭证。
 * 所有用例跨平台，不把替身 transport 当作 Linux peercred 验收。
 * 代码库关系：消费生产 LinuxEnvironmentClient；实际 Unix 入口由 Python Linux 测试覆盖。
 * 输入输出与副作用：内存与临时 Unix socket/Windows pipe fixture，关闭全部连接后清理目录；
 * 不使用模型、生产数据库、Podman 或桌面。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActionExecution } from "@kaguya/sdk";
import {
  createUnixBrokerTransport,
  LinuxEnvironmentClient,
  type BrokerTransport,
} from "./environment.js";

const transportCleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of transportCleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "transport cleanup failed");
});

async function socketFixture(
  onRequest: (socket: Socket, request: unknown) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), "kg-"));
  transportCleanups.push(() => rm(directory, { recursive: true, force: true }));
  const path =
    process.platform === "win32"
      ? `\\\\.\\pipe\\kg-${randomUUID()}`
      : join(directory, "broker.sock");
  const sockets = new Set<Socket>();
  const accepted = Promise.withResolvers<void>();
  let requests = 0;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (data) => {
      buffer += data.toString();
      if (!buffer.includes("\n")) return;
      requests++;
      onRequest(socket, JSON.parse(buffer));
      accepted.resolve();
    });
  });
  transportCleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    transport: createUnixBrokerTransport(path, 5000),
    accepted: accepted.promise,
    requests: () => requests,
  };
}

describe("broker socket transport", () => {
  it("parses a split response with a single dispatch", async () => {
    const f = await socketFixture((socket, request) => {
      expect(request).toEqual({ protocol: 1, method: "health", params: {} });
      socket.write('{"ok":true,"result":');
      socket.end('{"ready":true}}\n');
    });
    expect(await f.transport("health", {})).toEqual({ ready: true });
    expect(f.requests()).toBe(1);
  });

  it("aborts after actual admission without replay or cancellation claims", async () => {
    const f = await socketFixture(() => {});
    const controller = new AbortController();
    const pending = f.transport(
      "operation.execute",
      { operationId: "op" },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toThrow(
      "environment-request-aborted",
    );
    await f.accepted;
    controller.abort();
    await rejected;
    expect(f.requests()).toBe(1);
  });

  it("does not forward arbitrary broker error contents", async () => {
    const f = await socketFixture((socket) =>
      socket.end('{"ok":false,"error":"private-content"}\n'),
    );
    await expect(f.transport("health", {})).rejects.toThrow(
      /^environment-request-rejected$/,
    );
    expect(f.requests()).toBe(1);
  });
});

const reference = {
  environmentId: "env",
  generation: 0,
  workspaceId: "workspace",
  resourceIds: ["browser", "desktop"],
  workflowId: "workflow",
  leaseId: "lease",
  fencing: "1",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const secret = "private-lease-token-with-at-least-32-characters";
const success = {
  status: "succeeded",
  evidence: "returned",
  result: { count: 1 },
  artifacts: [],
  truncated: false,
};
function fixture() {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let current = { ...reference };
  let result: unknown = success;
  const transport: BrokerTransport = async (method, params) => {
    requests.push({ method, params });
    if (method === "lease.acquire")
      return { environment: current, token: secret };
    if (method === "lease.validate") return { valid: true };
    return result;
  };
  return {
    requests,
    client: new LinuxEnvironmentClient(transport),
    setCurrent: (r: typeof reference) => {
      current = r;
    },
    setResult: (r: unknown) => {
      result = r;
    },
  };
}
async function setup() {
  const f = fixture();
  await f.client.acquire({
    environmentId: "env",
    scope: "scope",
    workflowId: "workflow",
  });
  const input: ActionExecution = {
    intentId: "intent",
    attemptId: "attempt",
    operationId: "operation",
    digest: "digest",
    intent: {
      environment: reference,
      scope: "scope",
      operationId: "operation",
      toolName: "shell.exec",
      runInformationId: "run",
      decisionInformationId: "decision",
      sceneId: "scene",
      authorizationId: "authorization",
      authorizationVersion: 1,
      domain: "tool",
      providerId: "linux.environment",
      providerVersion: "1",
      executor: "linux",
      dependencies: {
        observationId: "observation",
        memoryRevisions: [],
        sourceInformationIds: [],
      },
      dependsOn: [],
      arguments: { command: "true" },
      target: {},
      deadline: "2099-01-01T00:00:00.000Z",
    },
    signal: new AbortController().signal,
  };
  return { ...f, input };
}

describe("Linux environment action adapter", () => {
  it("rejects acquire responses for another environment or workflow", async () => {
    for (const changed of [
      { ...reference, environmentId: "other" },
      { ...reference, workflowId: "other" },
    ]) {
      const f = fixture();
      f.setCurrent(changed);
      await expect(
        f.client.acquire({
          environmentId: "env",
          scope: "scope",
          workflowId: "workflow",
        }),
      ).rejects.toThrow("environment-acquire-identity-mismatch");
      await expect(f.client.renew("env", "scope")).rejects.toThrow(
        "environment-binding-mismatch",
      );
      expect(f.requests).toHaveLength(1);
    }
  });

  it("rejects renewed lease identity changes and retains the original binding", async () => {
    const f = await setup();
    for (const changed of [
      { ...reference, environmentId: "other" },
      { ...reference, workflowId: "other" },
      { ...reference, generation: 1 },
      { ...reference, fencing: "2" },
      { ...reference, leaseId: "other" },
      { ...reference, workspaceId: "other" },
      { ...reference, resourceIds: ["other"] },
    ]) {
      f.setResult(changed);
      await expect(f.client.renew("env", "scope")).rejects.toThrow(
        "environment-renew-identity-mismatch",
      );
      expect(
        await f.client.actionHooks.resolveLeaseCredential(f.input, "execute"),
      ).toEqual({ token: secret });
      expect(f.requests.at(-1)!.params.environment).toEqual(reference);
    }
    const renewed = { ...reference, expiresAt: "2099-01-02T00:00:00.000Z" };
    f.setResult(renewed);
    expect(await f.client.renew("env", "scope")).toEqual(renewed);
  });

  it("retains cleanup credentials until a matching quarantined release is confirmed", async () => {
    const f = await setup();
    const receipt = {
      environmentId: "env",
      scope: "scope",
      generation: 0,
      state: "quarantined",
    };
    for (const rejected of [
      {},
      { ...receipt, environmentId: "other" },
      { ...receipt, scope: "other" },
      { ...receipt, generation: 1 },
      { ...receipt, state: "ready" },
      { ...receipt, state: "draining" },
    ]) {
      f.setResult(rejected);
      await expect(f.client.release("env", "scope")).rejects.toThrow();
      expect(f.requests.at(-1)!.params).toEqual({
        environment: reference,
        token: secret,
        scope: "scope",
      });
    }
    f.setResult(receipt);
    await f.client.closeOwnedInputs();
    expect(f.requests.at(-1)!.method).toBe("lease.release");
    const requestCount = f.requests.length;
    await f.client.closeOwnedInputs();
    expect(f.requests).toHaveLength(requestCount);
    await expect(f.client.release("env", "scope")).rejects.toThrow(
      "environment-binding-mismatch",
    );
  });

  it("returns only public lease identity and resolves credentials only at execution", async () => {
    const f = await setup();
    expect(JSON.stringify(f.client)).not.toContain(secret);
    expect(JSON.stringify(f.input)).not.toContain(secret);
    f.input.leaseCredential = await f.client.actionHooks.resolveLeaseCredential(
      f.input,
      "execute",
    );
    const provider = f.client.provider();
    expect(await provider.execute(f.input)).toEqual(success);
    const request = f.requests.at(-1)!;
    expect(request.method).toBe("operation.execute");
    expect(request.params).toMatchObject({
      token: secret,
      attemptId: "attempt",
      operationId: "operation",
      digest: "digest",
    });
    expect(request.params.environment).toEqual(reference);
  });

  it("reconciles the original attempt under a new lease without replacing its generation", async () => {
    const f = await setup();
    const next = {
      ...reference,
      generation: 1,
      leaseId: "new",
      fencing: "2",
      workflowId: "next",
    };
    f.setCurrent(next);
    await f.client.acquire({
      environmentId: "env",
      scope: "scope",
      workflowId: "next",
    });
    f.input.reconciliationEnvironment = next;
    f.input.controlAuthorizationId = "control";
    f.input.leaseCredential = await f.client.actionHooks.resolveLeaseCredential(
      f.input,
      "reconcile",
    );
    await f.client.provider().reconcile!(f.input);
    expect(f.requests.at(-1)).toMatchObject({
      method: "operation.reconcile",
      params: {
        environment: { generation: 0 },
        controlEnvironment: { generation: 1 },
        attemptId: "attempt",
        digest: "digest",
      },
    });
    expect(
      f.requests.filter((r) => r.method === "operation.execute"),
    ).toHaveLength(0);
  });

  it("preserves actual succeeded evidence returned by cancellation", async () => {
    const f = await setup();
    f.input.controlAuthorizationId = "control";
    f.input.leaseCredential = await f.client.actionHooks.resolveLeaseCredential(
      f.input,
      "cancel",
    );
    expect(await f.client.provider().cancel!(f.input)).toEqual(success);
    expect(f.requests.at(-1)?.params.controlAuthorizationId).toBe("control");
  });

  it("refuses cross-scope or changed workspace bindings before transport", async () => {
    const f = await setup();
    f.input.intent.environment = { ...reference, workspaceId: "wrong" };
    await expect(
      f.client.actionHooks.resolveLeaseCredential(f.input, "execute"),
    ).rejects.toThrow("environment-binding-mismatch");
    f.input.intent.environment = reference;
    f.input.intent.scope = "wrong";
    await expect(
      f.client.actionHooks.resolveLeaseCredential(f.input, "execute"),
    ).rejects.toThrow("environment-binding-mismatch");
    expect(f.requests).toHaveLength(1);
  });

  it("refuses control requests without current authorization and rejects leaked secrets", async () => {
    const f = await setup();
    await expect(f.client.provider().cancel!(f.input)).rejects.toThrow(
      "environment-control-authorization-required",
    );
    f.input.leaseCredential = await f.client.actionHooks.resolveLeaseCredential(
      f.input,
      "execute",
    );
    f.setResult({ ...success, result: { token: secret } });
    await expect(f.client.provider().execute(f.input)).rejects.toThrow(
      "environment-output-rejected",
    );
  });

  it("does not reuse an old operation under a replacement environment", async () => {
    const f = await setup();
    f.setCurrent({ ...reference, generation: 1 });
    await f.client.acquire({
      environmentId: "env",
      scope: "scope",
      workflowId: "workflow",
    });
    await expect(
      f.client.actionHooks.resolveLeaseCredential(f.input, "execute"),
    ).rejects.toThrow("environment-binding-mismatch");
    expect(
      await f.client.actionHooks.validateEnvironment(f.input, "result"),
    ).toBe(false);
  });
});
