/**
 * 功能概述：验证唯一 Runtime Composition 的目录演化、激活选择和宿主依赖边界。
 * Memory 开启时共享工厂自动补入独立写回实例，并在关闭态移除后台实例。
 * 主要职责：模拟一方 Catalog 新增与移除定义，确认共享工厂直接采用变更；检查禁用实例
 * 不获得 Model Task 审批、身份和 Memory 选项保持原有语义，并约束两个应用直接使用正式入口。
 * 代码库关系：mock 仅替换 @kaguya/modules 的 Catalog 工厂，其他定义、配置校验及模板均为真实实现；
 * 应用的实际启动和投递行为另由 server-composition.test.ts 与 demo/index.test.ts 覆盖。
 * 输入输出与副作用：纯内存装配与源码读取，不启动 Runtime 或连接外部服务；每例恢复 mock。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as modules from "@kaguya/modules";
import { createMessageCatalog, createMessageComposition } from "./index.js";

vi.mock("@kaguya/modules", async (importOriginal) => {
  const actual = await importOriginal<typeof modules>();
  return {
    ...actual,
    createFirstPartyModuleCatalog: vi.fn(actual.createFirstPartyModuleCatalog),
  };
});

afterEach(() => vi.mocked(modules.createFirstPartyModuleCatalog).mockReset());

describe("shared Runtime Composition", () => {
  it("adopts an added and then removed catalog definition without an app registry", () => {
    const original = createMessageCatalog();
    const base = original.definitions.find(
      ({ manifest }) => manifest.definitionId === "core.identity.normalize",
    )!;
    const extra = {
      ...base,
      manifest: { ...base.manifest, definitionId: "test.catalog.extra" },
    };
    const extraConfig = {
      version: 1 as const,
      instanceId: "extra.default",
      definitionId: extra.manifest.definitionId,
      enabled: true,
      settings: {},
    };
    const defaults = modules.createFirstPartyModuleConfigDefaults("test");
    vi.mocked(modules.createFirstPartyModuleCatalog).mockReturnValue({
      ...original,
      definitions: [...original.definitions, extra],
    });
    const added = createMessageComposition(undefined, {
      moduleConfigs: [...defaults, extraConfig],
    });
    expect(added.catalog.definitions).toContain(extra);
    expect(added.activations).toContainEqual({
      instanceId: extraConfig.instanceId,
      definitionId: extraConfig.definitionId,
      enabled: true,
      settings: {},
    });

    vi.mocked(modules.createFirstPartyModuleCatalog).mockReturnValue(original);
    const removed = createMessageComposition(undefined, {
      moduleConfigs: defaults,
    });
    expect(removed.catalog.definitions).not.toContain(extra);
    expect(
      removed.activations.some(
        ({ definitionId }) => definitionId === extraConfig.definitionId,
      ),
    ).toBe(false);
    expect(() =>
      createMessageComposition(undefined, {
        moduleConfigs: [...defaults, extraConfig],
      }),
    ).toThrow("Unknown module definition: test.catalog.extra");
  });

  it("derives approvals from enabled activations and preserves host options", () => {
    const identity = { name: "Moon", aliases: ["月"], persona: "test persona" };
    const moduleConfigs = modules
      .createFirstPartyModuleConfigDefaults("test")
      .map((config) =>
        config.definitionId === "agent.message-composer"
          ? { ...config, enabled: false }
          : config,
      );
    const composition = createMessageComposition(undefined, {
      moduleConfigs,
      agentIdentity: identity,
      memoryEnabled: true,
    });
    expect(composition.modelTask.approvals).toEqual([]);
    expect(composition.activations).toHaveLength(moduleConfigs.length);
    expect(
      composition.activations.some(
        ({ definitionId }) => definitionId === "agent.memory.writeback",
      ),
    ).toBe(true);
    expect(
      composition.activations.find(
        ({ definitionId }) => definitionId === "agent.heartflow.online",
      )?.settings,
    ).toMatchObject({ botNames: ["Moon", "月"] });
    expect(composition.memory).toEqual({ enabled: true });
    expect(
      createMessageComposition(undefined, { moduleConfigs }).memory,
    ).toEqual({ enabled: false });
  });

  it.each([
    "server/src/server.ts",
    "demo/src/index.ts",
    "server/src/postgres-development.ts",
  ])(
    "%s uses the shared composition package without a local catalog factory",
    (entry) => {
      const source = readFileSync(
        new URL(`../../../apps/${entry}`, import.meta.url),
        "utf8",
      );
      expect(source).toMatch(/from "@kaguya\/composition"/u);
      expect(source).not.toMatch(
        /runtime-composition\.js|createFirstPartyModuleCatalog|createFirstPartyModuleActivations/u,
      );
    },
  );
});
