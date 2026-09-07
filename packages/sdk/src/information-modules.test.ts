/**
 * 功能概述：本文件验证信息模块 SDK 的最小公开订阅契约，防止旧的定向路由 API
 * 重新暴露到模块作者。
 * 主要职责：验证 `onInformation` 保存传入 definition，并让 handler 通过
 * `InformationModuleHandlerContext.register` 注册派生 atom；同时验证模块清单拒绝
 * 重复 kind，并断言 `onTargetedInformation` 不再导出。
 * 代码库关系：测试最终 `modules.ts` 及其经由 `index.ts` 的 SDK 出口；
 * engine `ModuleHost` 依赖同一 subscription definition 把消费者注册到 Core。
 * 输入输出与副作用：只构造内存中的 kind 和模块定义，不访问持久化或 Runtime；
 * 类型检查会确保 handler context 的公开方法保持为 `register`。
 */
import { z } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import * as informationModules from "./modules.js";
import * as sdk from "./index.js";
import {
  defineInformationKind,
  defineInformationModule,
  defineModuleDiagnostic,
  onInformation,
} from "./index.js";

const inputKind = defineInformationKind({
  kind: "acme.sdk.input",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const outputKind = defineInformationKind({
  kind: "acme.sdk.output",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

describe("information module SDK", () => {
  it("defines frozen, schema-bound module diagnostics", () => {
    const diagnostic = defineModuleDiagnostic({
      event: "acme.lookup.started",
      message: "Lookup started",
      level: "info",
      payloadSchema: z.object({ limit: z.number().int().positive() }).strict(),
      project: ({ limit }) => ({ limit }),
      detail: {
        sensitivity: "metadata",
        project: ({ limit }) => ({ configuredLimit: limit }),
      },
    });
    const module = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        moduleVersion: "1.0.0",
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
        diagnostics: [diagnostic],
        definitionId: "acme.diagnostics",
        displayName: "Diagnostics",
        settingsSchema: z.object({}).strict(),
        consumes: [],
        produces: [],
      },
      create: () => ({ provisions: [], subscriptions: [] }),
    });

    expect(module.manifest.diagnostics).toEqual([diagnostic]);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.detail)).toBe(true);
    expect(Object.isFrozen(module.manifest.diagnostics)).toBe(true);
  });

  it("rejects free-form diagnostic events and non-strict schemas", () => {
    expect(() =>
      defineModuleDiagnostic({
        event: "started",
        message: "Started",
        level: "info",
        payloadSchema: z.object({}),
        project: () => ({}),
      }),
    ).toThrow(/dotted namespace/);
    expect(() =>
      defineModuleDiagnostic({
        event: "acme.started",
        message: "Started",
        level: "info",
        payloadSchema: z.object({ value: z.string() }),
        project: () => ({}),
      }),
    ).toThrow(/strict object/);
  });

  it("defines non-targeted subscriptions that register derived atoms", () => {
    const subscription = onInformation(
      inputKind,
      { subscriptionId: "handle-inputkind", delivery: "live" },
      async (atom, context) => {
        await context.register(outputKind, {
          payload: { text: atom.payload.text },
        });
      },
    );

    expect(subscription).toMatchObject({
      kind: inputKind.kind,
      definition: inputKind,
    });
    expect(subscription).not.toHaveProperty("targeted");
    expect(informationModules).not.toHaveProperty("onTargetedInformation");
    expect(sdk).not.toHaveProperty("onTargetedInformation");
  });

  it("rejects duplicate declared kinds", () => {
    expect(() =>
      defineInformationModule({
        manifest: {
          protocolVersion: 1,
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "acme.duplicate",
          displayName: "Duplicate",
          settingsSchema: z.object({}).strict(),
          consumes: [inputKind, inputKind],
          produces: [inputKind, inputKind],
        },
        create: () => ({ provisions: [], subscriptions: [] }),
      }),
    ).toThrow(`Duplicate information module consumes: ${inputKind.kind}`);
  });
});
