/**
 * 原生 GUI 目录要求显式 guiModel 路由；人工控制配置不会自动替换普通模型。
 * 功能概述：跨平台验证 Linux 原生注册的 scope/target、串行 lease 绑定及关闭资源归属。
 * 使用受控 transport 核对实际 RPC；不将其视为 Podman 或 shell 运行证明。
 * 代码库关系：消费生产 LinuxToolsHost/Client，受影响 schema 与 hooks 均在此覆盖。
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionExecution } from "@kaguya/sdk";
import { LinuxToolsHost, linuxShellSchema } from "./linux-tools.js";
import { LinuxEnvironmentClient } from "./environment.js";
import {
  linuxBrowserActSchema,
  linuxBrowserVerifySchema,
} from "./linux-browser.js";
import { linuxGuiActSchema } from "./linux-gui.js";

describe("Linux native shell registry", () => {
  it("reacquires a control lease in a fresh host and cancels the original attempt only after acquisition succeeds", async () => {
    const original = {
      environmentId: "desktop",
      generation: 0,
      workspaceId: "work",
      resourceIds: ["gui"],
      workflowId: "flow",
      leaseId: "old",
      fencing: "1",
      expiresAt: "2026-01-01T00:00:00.000Z",
    };
    const current = {
      ...original,
      generation: 1,
      leaseId: "current",
      fencing: "2",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const calls: { method: string; params: unknown }[] = [];
    let available = false;
    const host = new LinuxToolsHost(
      {
        version: 1,
        revision: "one",
        bindings: [
          {
            scope: "scope",
            environmentId: "desktop",
            workflowId: "flow",
            gui: true,
            guiModel: {
              routeId: "gui",
              providerId: "vision",
              modelId: "model",
            },
          },
        ],
      },
      new LinuxEnvironmentClient(async (method, params) => {
        calls.push({ method, params });
        if (method === "lease.acquire") {
          if (!available) throw new Error("environment-not-ready");
          return {
            environment: current,
            token: "private-control-token-for-test-123456",
          };
        }
        if (method === "operation.cancel")
          return {
            status: "unknown",
            evidence: "unconfirmed",
            result: { reason: "old-effect-unconfirmed" },
            artifacts: [],
            truncated: false,
          };
        if (method === "lease.release")
          return {
            environmentId: "desktop",
            scope: "scope",
            generation: 1,
            state: "quarantined",
          };
        throw new Error(`unexpected RPC: ${method}`);
      }),
    );
    const input: ActionExecution = {
      intentId: "intent",
      attemptId: "original-attempt",
      operationId: "original-operation",
      digest: "original-digest",
      controlAuthorizationId: "control",
      signal: new AbortController().signal,
      intent: {
        environment: original,
        scope: "scope",
        operationId: "original-operation",
        toolName: "gui.observe",
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
        arguments: {},
        target: { scope: "scope", revision: "one" },
        deadline: "2026-01-01T00:00:00.000Z",
      },
    };
    try {
      const snapshot = host.snapshot();
      await expect(
        snapshot.actionEnvironment.resolveLeaseCredential(input, "cancel"),
      ).rejects.toThrow("environment-not-ready");
      expect(calls.map((call) => call.method)).toEqual(["lease.acquire"]);
      available = true;
      input.leaseCredential =
        await snapshot.actionEnvironment.resolveLeaseCredential(
          input,
          "cancel",
        );
      await snapshot.actionProviders[0]!.cancel!(input);
      expect(calls.map((call) => call.method)).toEqual([
        "lease.acquire",
        "lease.acquire",
        "operation.cancel",
      ]);
      expect(calls.at(-1)?.params).toMatchObject({
        environment: original,
        controlEnvironment: current,
        attemptId: "original-attempt",
        operationId: "original-operation",
        digest: "original-digest",
        controlAuthorizationId: "control",
      });
      const count = calls.length;
      await expect(
        snapshot.actionEnvironment.resolveLeaseCredential(
          {
            ...input,
            intent: {
              ...input.intent,
              environment: { ...original, workflowId: "other" },
            },
          },
          "cancel",
        ),
      ).rejects.toThrow("cancel-binding-denied");
      expect(calls).toHaveLength(count);
    } finally {
      await host.close();
    }
  });

  it("registers GUI only for its configured scope and keeps insertion distinct from replacement", async () => {
    const host = new LinuxToolsHost(
      {
        version: 1,
        revision: "gui-one",
        bindings: [
          {
            scope: "shell-only",
            environmentId: "shell",
            workflowId: "shell-flow",
          },
          {
            scope: "gui-scope",
            environmentId: "desktop",
            workflowId: "gui-flow",
            gui: true,
            guiModel: {
              routeId: "gui.approved",
              providerId: "vision",
              modelId: "gui",
            },
          },
        ],
      },
      new LinuxEnvironmentClient(async () => {
        throw new Error("unexpected-rpc");
      }),
    );
    try {
      expect(host.snapshot().nativeTools.guiTasks?.bindings).toEqual([
        {
          scope: "gui-scope",
          environmentId: "desktop",
          workflowId: "gui-flow",
          routeId: "gui.approved",
          revision: "gui-one",
        },
      ]);
      expect(host.snapshot().nativeTools.tasks).toEqual([
        {
          definitionId: "agent.heavy",
          taskId: "agent.heavy.respond",
          toolIds: ["shell.exec"],
        },
        {
          definitionId: "agent.heavy",
          taskId: "agent.gui.execute",
          routeId: "gui.approved",
          toolIds: ["gui.observe", "gui.act", "gui.verify"],
        },
      ]);
      const registrations = host.snapshot().nativeTools.registrations;
      expect(registrations.map((tool) => tool.id)).toEqual([
        "shell.exec",
        "gui.observe",
        "gui.act",
        "gui.verify",
      ]);
      await expect(
        registrations
          .find((tool) => tool.id === "gui.act")!
          .bind({
            scope: "shell-only",
            arguments: {},
            runInformationId: "run",
            stepInformationId: "step",
          }),
      ).rejects.toThrow("gui-scope-denied");
      const observation = {
        id: "a".repeat(64),
        environmentId: "desktop",
        workflowId: "gui-flow",
        generation: 0,
      };
      expect(
        linuxGuiActSchema.safeParse({
          action: "insert",
          observation,
          selector: { kind: "element", elementId: "e0" },
          text: "暂存",
        }).success,
      ).toBe(false);
      expect(
        linuxGuiActSchema.safeParse({
          action: "replace",
          observation,
          elementId: "e0",
          value: "暂存",
        }).success,
      ).toBe(true);
      expect(
        linuxGuiActSchema.safeParse({
          action: "launch_app",
          observation,
          argv: ["ignored"],
        }).success,
      ).toBe(false);
    } finally {
      await host.close();
    }
  });
  it("registers browser tools only for explicit browser scopes and rejects arbitrary scripts", async () => {
    const host = new LinuxToolsHost(
      {
        version: 1,
        revision: "browser-one",
        bindings: [
          {
            scope: "shell-only",
            environmentId: "shell",
            workflowId: "shell-flow",
          },
          {
            scope: "browser-scope",
            environmentId: "browser",
            workflowId: "browser-flow",
            browser: true,
          },
        ],
      },
      new LinuxEnvironmentClient(async () => {
        throw new Error("unexpected-rpc");
      }),
    );
    try {
      const snapshot = host.snapshot();
      expect(snapshot.nativeTools.registrations.map((tool) => tool.id)).toEqual(
        ["shell.exec", "browser.observe", "browser.act", "browser.verify"],
      );
      expect(snapshot.nativeTools.tasks[0]?.toolIds).toEqual([
        "shell.exec",
        "browser.observe",
        "browser.act",
        "browser.verify",
      ]);
      const browser = snapshot.nativeTools.registrations.find(
        (tool) => tool.id === "browser.act",
      )!;
      await expect(
        browser.bind({
          scope: "shell-only",
          arguments: {},
          runInformationId: "run",
          stepInformationId: "step",
        }),
      ).rejects.toThrow("browser-scope-denied");
      expect(
        await browser.authorize({
          intent: {
            scope: "shell-only",
            environment: { environmentId: "shell", workflowId: "shell-flow" },
            target: { scope: "shell-only", revision: "browser-one" },
            providerId: "linux.environment",
            executor: "linux",
          } as any,
          mode: "execute",
        }),
      ).toBe(false);
      const observation = {
        id: "a".repeat(64),
        environmentId: "browser",
        workflowId: "browser-flow",
        generation: 0,
      };
      expect(
        linuxBrowserActSchema.safeParse({
          observation,
          action: "click",
          nodeId: "n1",
        }).success,
      ).toBe(true);
      expect(
        linuxBrowserActSchema.safeParse({
          observation,
          action: "evaluate",
          script: "submit()",
        }).success,
      ).toBe(false);
      expect(
        linuxBrowserActSchema.safeParse({
          observation,
          action: "click",
          nodeId: "n1",
          script: "submit()",
        }).success,
      ).toBe(false);
      expect(
        linuxBrowserVerifySchema.safeParse({
          observation,
          mode: "page",
          expectation: { kind: "url", equals: "https://example.com/" },
        }).success,
      ).toBe(false);
    } finally {
      await host.close();
    }
  });
  it("maintains idle short leases; failed renew requires explicit recovery; lost release ACK can be retried", async () => {
    vi.useFakeTimers();
    let generation = 0,
      expires = Date.now() + 3000,
      failRenew = false,
      failRelease = true;
    const calls: string[] = [];
    const reference = () => ({
      environmentId: "env",
      generation,
      workspaceId: "work",
      resourceIds: ["shell"],
      workflowId: "flow",
      leaseId: `lease${generation}`,
      fencing: String(generation + 1),
      expiresAt: new Date(expires).toISOString(),
    });
    const host = new LinuxToolsHost(
      {
        version: 1,
        revision: "one",
        bindings: [
          { scope: "scope", environmentId: "env", workflowId: "flow" },
        ],
      },
      new LinuxEnvironmentClient(async (method) => {
        calls.push(method);
        if (method === "lease.acquire")
          return {
            environment: reference(),
            token: "private-token-not-for-the-model-123456",
          };
        if (method === "lease.renew") {
          if (failRenew || expires <= Date.now())
            throw new Error("lease-unavailable");
          expires = Date.now() + 3000;
          return reference();
        }
        if (method === "environment.recover") {
          generation++;
          expires = Date.now() + 3000;
          return {
            environmentId: "env",
            scope: "scope",
            generation,
            state: "ready",
          };
        }
        if (method === "lease.release" && failRelease) {
          failRelease = false;
          throw new Error("ack-lost");
        }
        if (method === "lease.release")
          return {
            environmentId: "env",
            scope: "scope",
            generation,
            state: "quarantined",
          };
        return {};
      }),
      3,
    );
    try {
      await host.bind("scope");
      await vi.advanceTimersByTimeAsync(7000);
      expect(calls.filter((m) => m === "lease.renew")).toHaveLength(7);
      expect(expires).toBeGreaterThan(Date.now());
      failRenew = true;
      await vi.advanceTimersByTimeAsync(1000);
      await expect(host.bind("scope")).rejects.toThrow("scope-denied");
      expect(calls).not.toContain("environment.recover");
      await host.recover("scope", 0, "explicit-control");
      failRenew = false;
      expect((await host.bind("scope")).generation).toBe(1);
      await expect(host.close()).rejects.toThrow("cleanup-unconfirmed");
      await host.close();
      expect(calls.filter((m) => m === "lease.release")).toHaveLength(2);
    } finally {
      failRelease = false;
      try {
        await host.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });
  it("serializes acquire/renew and keeps tokens out of bindings and registrations", async () => {
    const calls: string[] = [];
    const environment = {
      environmentId: "env",
      generation: 0,
      workspaceId: "work",
      resourceIds: ["shell"],
      workflowId: "flow",
      leaseId: "lease",
      fencing: "1",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const client = new LinuxEnvironmentClient(async (method) => {
      calls.push(method);
      if (method === "lease.acquire")
        return { environment, token: "private-token-not-for-the-model-123456" };
      if (method === "lease.renew") return environment;
      if (method === "lease.release")
        return {
          environmentId: "env",
          scope: "scope",
          generation: environment.generation,
          state: "quarantined",
        };
      return {};
    });
    const host = new LinuxToolsHost(
      {
        version: 1,
        revision: "one",
        bindings: [
          { scope: "scope", environmentId: "env", workflowId: "flow" },
        ],
      },
      client,
    );
    try {
      const refs = await Promise.all([host.bind("scope"), host.bind("scope")]);
      expect(calls).toEqual(["lease.acquire", "lease.renew"]);
      expect(JSON.stringify(refs)).not.toContain("private-token");
      const tool = host.snapshot().nativeTools.registrations[0]!;
      const binding = await tool.bind({
        scope: "scope",
        arguments: {},
        runInformationId: "run",
        stepInformationId: "step",
      });
      const intent = {
        environment: binding.environment,
        scope: "scope",
        target: binding.target,
        providerId: "linux.environment",
        executor: "linux",
      } as any;
      expect(await tool.authorize({ intent, mode: "execute" })).toBe(true);
      expect(
        await tool.authorize({
          intent: { ...intent, scope: "other" },
          mode: "execute",
        }),
      ).toBe(false);
      await expect(host.bind("other")).rejects.toThrow("scope-denied");
      expect(
        linuxShellSchema.safeParse({
          mode: "start",
          argv: ["/bin/true"],
          token: "injected",
        }).success,
      ).toBe(false);
      expect(
        linuxShellSchema.safeParse({
          mode: "verify",
          original: { operationId: "op", attemptId: "attempt" },
          path: "a",
        }).success,
      ).toBe(true);
    } finally {
      await host.close();
    }
    expect(calls.at(-1)).toBe("lease.release");
    await expect(host.bind("scope")).rejects.toThrow();
  });
});
