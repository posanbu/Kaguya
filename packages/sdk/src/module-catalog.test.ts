/**
 * 功能概述：验证唯一模块协议的静态 Catalog、能力身份和版本边界。
 * 主要职责：通过真实 SDK 定义证明重复 ID 与不兼容协议立即拒绝、合并顺序确定。
 * 代码库关系：供 modules.ts 的先失败后实现流程和后续 Host 预检复用。
 * 输入输出与副作用：仅构造内存 definition；不启动模块或访问外部资源。
 */
import { describe, expect, it } from "vitest";
import { z } from "@kaguya/schema";
import {
  defineInformationModule,
  defineInformationModuleCatalog,
  mergeInformationModuleCatalogs,
  defineModuleCapability,
} from "./modules.js";
const module = (definitionId: string) =>
  defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId,
      displayName: definitionId,
      description: `${definitionId} information module`,
      settingsSchema: z.object({}),
      consumes: [],
      produces: [],
      selectors: [],
      promptRenderers: [],
      requires: [],
      provides: [],
    },
    create: () => ({ subscriptions: [], provisions: [] }),
  });
describe("module catalog", () => {
  it("contains only definitions explicitly registered by the composition root", () => {
    const registered = module("test.registered");
    const unregistered = module("test.unregistered");
    const catalog = defineInformationModuleCatalog(registered);

    expect(catalog.definitions).toEqual([registered]);
    expect(catalog.definitions).not.toContain(unregistered);
  });

  it("merges deterministically and rejects duplicate definitions", () => {
    const a = module("test.a"),
      b = module("test.b");
    expect(
      mergeInformationModuleCatalogs(
        defineInformationModuleCatalog(b),
        defineInformationModuleCatalog(a),
      ).definitions.map((d) => d.manifest.definitionId),
    ).toEqual(["test.a", "test.b"]);
    expect(() => defineInformationModuleCatalog(a, a)).toThrow(/Duplicate/);
  });
  it("rejects incompatible versions and unsafe capability identities", () => {
    const a = module("test.a");
    expect(() =>
      defineInformationModule({
        ...a,
        manifest: { ...a.manifest, protocolVersion: 2 as 1 },
      }),
    ).toThrow(/protocol/);
    expect(() =>
      defineInformationModule({
        ...a,
        manifest: { ...a.manifest, moduleVersion: "latest" },
      }),
    ).toThrow(/version/);
    expect(() => defineModuleCapability("bare", 1)).toThrow(/namespace/);
    expect(
      defineModuleCapability<{ read(): string }>("test:reader", 1),
    ).toEqual({ id: "test:reader", apiVersion: 1 });
  });
});
