/**
 * 功能概述：验证人工 GUI 会话从宿主控制到 broker RPC 的身份、秘密和去重合同。
 * 主要职责：显式 barrier 控制接管与输入返回，验证续租不会越过接管、丢失回执不重复输入。
 * 代码库关系：使用真实 LinuxToolsHost/Client 和受控 transport；物理排空由 Linux helper 测试承担。
 * 输入输出与副作用：全内存；finally 释放 barrier 并关闭宿主，不调用模型或真实桌面。
 */
import { describe, expect, it } from "vitest";
import { LinuxEnvironmentClient, type BrokerTransport } from "./environment.js";
import { LinuxToolsHost } from "./linux-tools.js";

const success = {
  status: "succeeded",
  evidence: "returned",
  result: {},
  artifacts: [],
  truncated: false,
};
function fixture() {
  const calls: { method: string; params: Record<string, any> }[] = [];
  const state = {
    generation: 0,
    state: "ready",
    sessionId: "",
    failHandoff: false,
    failInput: false,
    failBeforeHandoff: false,
    failBeforeResume: false,
    failCleanup: false,
    renewGate: undefined as Promise<void> | undefined,
    handoffGate: undefined as Promise<void> | undefined,
    inputGate: undefined as Promise<void> | undefined,
  };
  const entered = Promise.withResolvers<void>();
  const renewEntered = Promise.withResolvers<void>();
  const inputEntered = Promise.withResolvers<void>();
  const snapshot = () => ({
    environmentId: "env",
    scope: "scope",
    generation: state.generation,
    state: state.state,
    ...(state.sessionId
      ? {
          human: {
            sessionId: state.sessionId,
            expiresAt: "2099-01-01T00:00:00Z",
          },
        }
      : {}),
    token: "should-be-projected-away",
  });
  const transport: BrokerTransport = async (method, params) => {
    calls.push({ method, params });
    if (
      state.failCleanup &&
      ["environment.inspect", "human.close", "lease.release"].includes(method)
    )
      throw new Error("cleanup-offline");
    if (method === "lease.renew") {
      renewEntered.resolve();
      await state.renewGate;
    }
    if (method === "lease.release") {
      if ((params.environment as any).generation !== state.generation)
        throw new Error("stale-lease");
      state.state = "quarantined";
      return snapshot();
    }
    if (method === "lease.acquire" || method === "lease.renew")
      return method === "lease.acquire"
        ? {
            token: "lease-secret-with-at-least-32-characters",
            environment: {
              environmentId: "env",
              generation: state.generation,
              workspaceId: "workspace",
              resourceIds: ["desktop"],
              workflowId: "flow",
              leaseId: "lease",
              fencing: "1",
              expiresAt: "2099-01-01T00:00:00Z",
            },
          }
        : params.environment;
    if (method === "environment.handoff") {
      entered.resolve();
      await state.handoffGate;
      if (state.failBeforeHandoff) throw new Error("not-delivered");
      state.generation = Number(params.generation) + 1;
      state.state = "human";
      state.sessionId = (params.humanSession as { id: string }).id;
      if (state.failHandoff) {
        state.failHandoff = false;
        throw new Error("lost-ack");
      }
      return snapshot();
    }
    if (method === "human.execute") {
      inputEntered.resolve();
      await state.inputGate;
      if (state.failInput) throw new Error("lost-input-receipt");
      return success;
    }
    if (method === "human.query") {
      const original = calls.find(
        (call) => call.method === "human.execute",
      )!.params;
      return {
        operationId: original.operationId,
        attemptId: original.attemptId,
        outcome: success,
      };
    }
    if (method === "human.close" || method === "environment.resume") {
      if (method === "environment.resume" && state.failBeforeResume)
        throw new Error("resume-not-delivered");
      if (
        Number(params.generation) !== state.generation ||
        state.state !== "human" ||
        (method === "human.close" && params.sessionId !== state.sessionId)
      )
        throw new Error("stale-human");
      state.generation = Number(params.generation) + 1;
      state.state = method === "human.close" ? "human" : "ready";
      state.sessionId = "";
    }
    return snapshot();
  };
  const client = new LinuxEnvironmentClient(transport);
  const host = new LinuxToolsHost(
    {
      version: 1,
      revision: "one",
      bindings: [
        { environmentId: "env", scope: "scope", workflowId: "flow", gui: true },
      ],
    },
    client,
  );
  return { client, host, calls, state, entered, inputEntered, renewEntered };
}

describe("manual GUI host", () => {
  it("reuses private credentials after lost handoff ACK and projects public state", async () => {
    const f = fixture();
    f.state.failHandoff = true;
    try {
      await expect(f.host.handoff("env", 0, "control")).rejects.toThrow(
        "lost-ack",
      );
      const publicState = await f.host.handoff("env", 0, "control");
      const handoffs = f.calls.filter(
        (call) => call.method === "environment.handoff",
      );
      expect(handoffs[0]!.params).toEqual(handoffs[1]!.params);
      expect(JSON.stringify(publicState)).not.toContain("token");
      const privateToken = handoffs[0]!.params.humanSession.token;
      expect(JSON.stringify(publicState)).not.toContain(privateToken);
      expect(publicState.human?.sessionId).toHaveLength(64);
      await expect(f.host.bind("scope")).rejects.toThrow();
      await f.host.maintain();
      expect(
        f.calls.filter((call) => call.method.startsWith("lease.")),
      ).toHaveLength(0);
    } finally {
      await f.host.close();
    }
  });

  it("fences a renewal queued behind an admitted renewal before handoff", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    const work: Promise<unknown>[] = [];
    try {
      await f.host.bind("scope");
      f.state.renewGate = gate.promise;
      const first = f.host.bind("scope");
      work.push(first);
      await f.renewEntered.promise;
      const queued = f.host.bind("scope");
      const denied = expect(queued).rejects.toThrow();
      work.push(denied);
      const handoff = f.host.handoff("env", 0, "control");
      work.push(handoff);
      gate.resolve();
      await Promise.all([first, denied, handoff]);
      expect(
        f.calls.filter((call) => call.method === "lease.renew"),
      ).toHaveLength(1);
      await f.host.resume("env", 1, "resume");
      expect((await f.host.bind("scope")).generation).toBe(2);
    } finally {
      gate.resolve();
      try {
        await Promise.allSettled(work);
      } finally {
        await f.host.close();
      }
    }
  });

  it("retains cleanup owners when handoff never reaches the broker", async () => {
    const f = fixture();
    try {
      await f.host.bind("scope");
      f.state.failBeforeHandoff = true;
      await expect(f.host.handoff("env", 0, "control")).rejects.toThrow(
        "not-delivered",
      );
      await expect(f.host.bind("scope")).rejects.toThrow();
      await f.host.close();
      expect(f.state.state).toBe("quarantined");
      expect(
        f.calls.filter((call) => call.method === "lease.release"),
      ).toHaveLength(1);
    } finally {
      await f.host.close();
    }
  });

  it("closes the candidate session after a lost handoff ACK without returning to automation", async () => {
    const f = fixture();
    try {
      await f.host.bind("scope");
      f.state.failHandoff = true;
      await expect(f.host.handoff("env", 0, "control")).rejects.toThrow(
        "lost-ack",
      );
      expect(f.state.state).toBe("human");
      await f.host.close();
      expect(f.state.state).toBe("human");
      expect(f.state.sessionId).toBe("");
      expect(
        f.calls.filter((call) => call.method === "human.close"),
      ).toHaveLength(1);
    } finally {
      await f.host.close();
    }
  });

  it("retains the manual owner when resume is not delivered and reports unconfirmed cleanup", async () => {
    const f = fixture();
    try {
      await f.host.handoff("env", 0, "control");
      f.state.failBeforeResume = true;
      await expect(f.host.resume("env", 1, "resume")).rejects.toThrow(
        "resume-not-delivered",
      );
      f.state.failCleanup = true;
      await expect(f.host.close()).rejects.toThrow("cleanup-unconfirmed");
      expect(f.state.sessionId).not.toBe("");
      f.state.failCleanup = false;
      await f.host.close();
      expect(f.state.state).toBe("human");
      expect(f.state.sessionId).toBe("");
    } finally {
      f.state.failCleanup = false;
      await f.host.close();
    }
  });

  it("keeps unknown input identity and queries facts without another dispatch", async () => {
    const f = fixture();
    f.state.failInput = true;
    try {
      const current = await f.host.handoff("env", 0, "control");
      const request = {
        environmentId: "env",
        generation: current.generation,
        sessionId: current.human!.sessionId,
        operationId: "op",
        toolName: "gui.act" as const,
        arguments: {
          action: "click",
          observation: {
            id: "a".repeat(64),
            environmentId: "env",
            workflowId: "human",
            generation: current.generation,
          },
          selector: { kind: "pixel", x: 1, y: 2 },
        },
      };
      const first = await f.host.operateHuman(request);
      expect(first.outcome.status).toBe("unknown");
      expect(await f.host.operateHuman(request)).toEqual(first);
      const query = await f.host.queryHuman("env", "op");
      expect(query.attemptId).toBe(first.attemptId);
      expect(query.outcome.status).toBe("succeeded");
      expect(first.outcome.status).toBe("unknown");
      expect(
        f.calls.filter((call) => call.method === "human.execute"),
      ).toHaveLength(1);
      expect(() =>
        f.host.operateHuman({
          ...request,
          arguments: {
            ...request.arguments,
            selector: { kind: "pixel", x: 3, y: 2 },
          },
        }),
      ).toThrow("human-operation-conflict");
    } finally {
      await f.host.close();
    }
  });

  it("allows close to drain an in-flight human operation without waiting behind it", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    f.state.inputGate = gate.promise;
    let action: Promise<unknown> | undefined;
    try {
      const current = await f.host.handoff("env", 0, "control");
      const session = {
        environmentId: "env",
        generation: 1,
        sessionId: current.human!.sessionId,
      };
      action = f.host.operateHuman({
        ...session,
        operationId: "op",
        toolName: "gui.observe",
        arguments: { target: { kind: "desktop" } },
      });
      await f.inputEntered.promise;
      expect((await f.host.closeHuman(session)).state).toBe("human");
      expect(() =>
        f.host.operateHuman({
          ...session,
          operationId: "late",
          toolName: "gui.observe",
          arguments: { target: { kind: "desktop" } },
        }),
      ).toThrow("human-session-unavailable");
      expect(
        f.calls.filter((call) => call.method === "human.execute"),
      ).toHaveLength(1);
    } finally {
      gate.resolve();
      try {
        await action;
      } finally {
        await f.host.close();
      }
    }
  });
});
