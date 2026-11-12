/**
 * 功能概述：GUI 管理路由的真实 HTTP 注入测试，核对认证、scope 归属、秘密投影和原图响应。
 * 主要职责：通过真实 Fastify、LinuxToolsHost/Client 调用受控 broker，覆盖接管/输入/查询/关闭。
 * 代码库关系：直接注册生产 linux-environment-routes；不将 transport 替身作为物理 GUI 验收。
 * 输入输出与副作用：仅内存请求和合成 PNG；finally 关闭宿主定时器与 Fastify，无外部模型请求。
 */
import { createHash, randomUUID } from "node:crypto";
import fastify from "fastify";
import { expect, it } from "vitest";
import { LinuxEnvironmentClient, LinuxToolsHost } from "@kaguya/runtime";
import { createGatewayAuthenticator } from "./gateway-auth.js";
import { registerLinuxEnvironmentRoutes } from "./linux-environment-routes.js";

it("authenticates every management surface and retains private scope and credentials", async () => {
  const app = fastify();
  const requests: { method: string; params: Record<string, any> }[] = [];
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  let generation = 0,
    mode = "ready",
    sessionId: string | undefined;
  const publicState = () => ({
    environmentId: "env",
    scope: "configured-scope",
    generation,
    state: mode,
    ...(sessionId
      ? { human: { sessionId, expiresAt: "2099-01-01T00:00:00Z" } }
      : {}),
  });
  const host = new LinuxToolsHost(
    {
      version: 1,
      revision: "one",
      bindings: [
        {
          environmentId: "env",
          scope: "configured-scope",
          workflowId: "flow",
          gui: true,
        },
      ],
    },
    new LinuxEnvironmentClient(async (method, params) => {
      requests.push({ method, params });
      if (method === "environment.handoff") {
        generation++;
        mode = "human";
        sessionId = (params.humanSession as { id: string }).id;
      }
      if (method === "human.close") {
        generation++;
        sessionId = undefined;
      }
      if (method === "artifact.read")
        return {
          artifact: {
            mime: "image/png",
            hash: createHash("sha256").update(png).digest("hex"),
          },
          dataBase64: png.toString("base64"),
        };
      if (method === "environment.resume") {
        generation++;
        mode = "ready";
        sessionId = undefined;
      }
      if (method === "human.execute") {
        if (params.toolName === "gui.act")
          throw new Error("synthetic-lost-receipt-private-text");
        return {
          status: "succeeded",
          evidence: "returned",
          result: {},
          artifacts: [],
          truncated: false,
        };
      }
      if (method === "human.query") {
        const operation = requests.find(
          (r) =>
            r.method === "human.execute" && r.params.toolName === "gui.act",
        )!.params;
        return {
          operationId: operation.operationId,
          attemptId: operation.attemptId,
          outcome: {
            status: "unknown",
            evidence: "unconfirmed",
            result: { reason: "effect-unconfirmed" },
            artifacts: [],
            truncated: false,
          },
        };
      }
      return publicState();
    }),
  );
  registerLinuxEnvironmentRoutes(
    app,
    () => host,
    createGatewayAuthenticator("management-secret"),
  );
  const headers = { authorization: "Bearer management-secret" };
  const prefix = "/api/v1/environments/env";
  try {
    for (const url of [
      "/api/v1/environments",
      `${prefix}/control`,
      `${prefix}/images/image`,
      `${prefix}/human/operations/${randomUUID()}`,
    ]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
    for (const action of [
      "handoff",
      "resume",
      "human/observe",
      "human/input",
      "human/verify",
      "human/renew",
      "human/close",
    ])
      expect(
        (
          await app.inject({
            method: "POST",
            url: `${prefix}/${action}`,
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
    expect(requests).toHaveLength(0);
    const deniedScope = await app.inject({
      method: "POST",
      url: `${prefix}/handoff`,
      headers,
      payload: {
        generation: 0,
        controlAuthorizationId: randomUUID(),
        scope: "caller-scope",
      },
    });
    expect(deniedScope.statusCode).toBe(400);
    expect(requests).toHaveLength(0);
    const handoff = await app.inject({
      method: "POST",
      url: `${prefix}/handoff`,
      headers,
      payload: { generation: 0, controlAuthorizationId: randomUUID() },
    });
    expect(handoff.statusCode).toBe(200);
    expect(handoff.json().human.sessionId).toBe(sessionId);
    expect(handoff.body).not.toContain(
      requests.find((r) => r.method === "environment.handoff")!.params
        .humanSession.token,
    );
    const operationId = randomUUID();
    const payload = {
      generation: 1,
      sessionId,
      operationId,
      arguments: {
        action: "click",
        observation: {
          id: "a".repeat(64),
          environmentId: "env",
          workflowId: "human",
          generation: 1,
        },
        selector: { kind: "pixel", x: 1, y: 2 },
      },
    };
    const input = await app.inject({
      method: "POST",
      url: `${prefix}/human/input`,
      headers,
      payload,
    });
    expect(input.statusCode).toBe(200);
    expect(input.json().outcome.status).toBe("unknown");
    expect(input.body).not.toContain("private-text");
    const repeated = await app.inject({
      method: "POST",
      url: `${prefix}/human/input`,
      headers,
      payload,
    });
    expect(repeated.json()).toEqual(input.json());
    const observe = await app.inject({
      method: "POST",
      url: `${prefix}/human/observe`,
      headers,
      payload: {
        generation: 1,
        sessionId,
        operationId: randomUUID(),
        arguments: { target: { kind: "desktop" } },
      },
    });
    expect(observe.statusCode).toBe(200);
    const verify = await app.inject({
      method: "POST",
      url: `${prefix}/human/verify`,
      headers,
      payload: {
        generation: 1,
        sessionId,
        operationId: randomUUID(),
        arguments: {
          target: { kind: "desktop" },
          original: { operationId, attemptId: input.json().attemptId },
          verificationKind: "current-gui-state",
          contains: "visible",
        },
      },
    });
    expect(verify.statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${prefix}/human/renew`,
          headers,
          payload: { generation: 1, sessionId },
        })
      ).statusCode,
    ).toBe(200);
    const query = await app.inject({
      method: "GET",
      url: `${prefix}/human/operations/${operationId}`,
      headers,
    });
    expect(query.json().attemptId).toBe(input.json().attemptId);
    expect(
      requests.filter(
        (r) => r.method === "human.execute" && r.params.toolName === "gui.act",
      ),
    ).toHaveLength(1);
    expect(requests.every((r) => r.params.scope === "configured-scope")).toBe(
      true,
    );
    const image = await app.inject({
      method: "GET",
      url: `${prefix}/images/image`,
      headers,
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["cache-control"]).toBe("no-store");
    expect(image.headers["content-type"]).toBe("image/png");
    expect(image.rawPayload).toEqual(png);
    expect(requests.at(-1)!.params.environmentId).toBe("env");
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/environments/unconfigured/control",
          headers,
        })
      ).statusCode,
    ).toBe(409);
    const closed = await app.inject({
      method: "POST",
      url: `${prefix}/human/close`,
      headers,
      payload: { generation: 1, sessionId },
    });
    expect(closed.json().state).toBe("human");
    expect(closed.json().human).toBeUndefined();
    const late = await app.inject({
      method: "POST",
      url: `${prefix}/human/input`,
      headers,
      payload: { ...payload, operationId: randomUUID() },
    });
    expect(late.statusCode).toBe(409);
    expect(
      requests.filter(
        (r) => r.method === "human.execute" && r.params.toolName === "gui.act",
      ),
    ).toHaveLength(1);
    const resumed = await app.inject({
      method: "POST",
      url: `${prefix}/resume`,
      headers,
      payload: { generation: 2, controlAuthorizationId: randomUUID() },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().state).toBe("ready");
  } finally {
    try {
      await host.close();
    } finally {
      await app.close();
    }
  }
});
