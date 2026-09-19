/**
 * 功能概述：本文件验证信息模块 SDK 的最小公开订阅契约，防止旧的定向路由 API
 * 重新暴露到模块作者。
 * 主要职责：验证 `onInformation` 保存传入 definition，并让 handler 通过
 * `InformationModuleHandlerContext.register` 注册派生 atom；同时验证模块清单拒绝
 * 重复 kind，并断言 `onTargetedInformation` 不再导出。
 * ready 使用公开 LifecycleContext，在订阅已就绪的阶段复用取消信号与受限能力；顺序由 Host 测试覆盖。
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
  type InformationModuleLifecycleContext,
} from "./index.js";

const inputKind = defineInformationKind({
  kind: "acme.sdk.input",
  displayName: "Acme Sdk Input",
  description: "Information carried by the acme.sdk.input kind.",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const outputKind = defineInformationKind({
  kind: "acme.sdk.output",
  displayName: "Acme Sdk Output",
  description: "Information carried by the acme.sdk.output kind.",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

describe("information module SDK", () => {
  it("exposes ready with the same lifecycle capabilities as start", async () => {
    const signal = new AbortController().signal;
    const context: InformationModuleLifecycleContext = {
      signal,
      now: () => new Date("2026-09-19T00:00:00.000Z"),
      use: () => {
        throw new Error("No capability declared");
      },
      report: async () => undefined,
    };
    let readyContext: InformationModuleLifecycleContext | undefined;
    const module = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        moduleVersion: "1.0.0",
        definitionId: "acme.ready",
        displayName: "Readiness",
        summary: "Declares readiness.",
        description: "Initializes after subscriptions are ready.",
        settingsSchema: z.object({}).strict(),
        consumes: [],
        produces: [],
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
      },
      create: () => ({
        provisions: [],
        subscriptions: [],
        ready: (lifecycle) => {
          readyContext = lifecycle;
        },
      }),
    });
    const instance = await module.create(
      {
        instanceId: "ready.test",
        settings: {},
        activation: {
          instanceId: "ready.test",
          definitionId: module.manifest.definitionId,
        },
      },
      context,
    );
    await instance.ready?.(context);
    expect(readyContext).toBe(context);
    expect(readyContext?.signal).toBe(signal);
    expect(readyContext?.now().toISOString()).toBe("2026-09-19T00:00:00.000Z");
  });
  it("requires and freezes module and prompt display metadata", () => {
    const promptRenderer = {
      rendererId: "acme.prompt.input",
      displayName: "Acme input prompt",
      description: "Renders accepted Acme input for a model prompt.",
      kinds: [inputKind],
      render: () => "input",
    };
    const module = defineInformationModule({
      manifest: {
        protocolVersion: 1,
        summary: "Test information module.",
        moduleVersion: "1.0.0",
        definitionId: "acme.prompt",
        displayName: "Acme prompt",
        description: "Compiles Acme input into model context.",
        settingsSchema: z.object({}).strict(),
        consumes: [inputKind],
        produces: [],
        selectors: [],
        promptRenderers: [promptRenderer],
        requires: [],
        provides: [],
      },
      create: () => ({ provisions: [], subscriptions: [] }),
    });

    expect(module.manifest.summary).toBe("Test information module.");
    expect(module.manifest.description).toBe(
      "Compiles Acme input into model context.",
    );
    expect(() =>
      defineInformationModule({
        ...module,
        manifest: { ...module.manifest, summary: "two\nlines" },
      }),
    ).toThrow(/module summary/iu);
    expect(Object.isFrozen(module.manifest.promptRenderers[0])).toBe(true);
    expect(() =>
      defineInformationModule({
        ...module,
        manifest: { ...module.manifest, description: " " },
      }),
    ).toThrow(/module description/iu);
    expect(() =>
      defineInformationModule({
        ...module,
        manifest: {
          ...module.manifest,
          promptRenderers: [{ ...promptRenderer, description: " " }],
        },
      }),
    ).toThrow(/invalid renderer/iu);
  });

  it("validates and deeply freezes declarative inspection surfaces", () => {
    const inspection = {
      mechanism: ["Inspect the entity."],
      views: [
        {
          id: "entities",
          title: "Entities",
          description: "Entity records.",
          kinds: [outputKind.kind],
          fields: [
            { path: "text", label: "Text" },
            { path: "status", label: "Status" },
          ],
        },
      ],
      surface: {
        version: 1 as const,
        id: "entity-surface",
        title: "Entities",
        layout: { type: "master-detail" as const, areas: ["main"] },
        components: [
          {
            id: "summary",
            type: "status-summary" as const,
            area: "main",
            viewId: "entities",
            kinds: [outputKind.kind],
            statusField: "status",
            windowHours: 24,
          },
          {
            id: "browser",
            type: "entity-browser" as const,
            area: "main",
            viewId: "entities",
            entityKind: outputKind.kind,
            entityKeyField: "text",
            activity: {
              viewId: "entities",
              kinds: [outputKind.kind],
              entityKeyField: "text",
            },
            titleFields: [{ path: "text", label: "Text" }],
            searchFields: [
              { viewId: "entities", kind: outputKind.kind, path: "text" },
            ],
            platform: {
              viewId: "entities",
              kind: outputKind.kind,
              field: "text",
              entityKeyField: "text",
            },
            status: {
              viewId: "entities",
              kinds: [outputKind.kind],
              entityField: "text",
              statusField: "status",
            },
            relations: [
              {
                id: "related",
                title: "Related",
                viewId: "entities",
                kinds: [outputKind.kind],
                match: { source: "entity-key" as const, field: "text" },
                presentation: "relation-list" as const,
                fields: [{ path: "text", label: "Text" }],
                limit: 20,
              },
            ],
          },
        ],
      },
    };
    const definition = {
      manifest: {
        protocolVersion: 1 as const,
        summary: "Surface module.",
        moduleVersion: "1.0.0",
        definitionId: "acme.surface",
        displayName: "Surface",
        description: "Defines a declarative surface.",
        settingsSchema: z.object({}).strict(),
        consumes: [],
        produces: [outputKind],
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
        inspection,
      },
      create: () => ({ provisions: [], subscriptions: [] }),
    };
    const module = defineInformationModule(definition);
    expect(Object.isFrozen(module.manifest.inspection?.surface)).toBe(true);
    expect(
      Object.isFrozen(module.manifest.inspection?.surface?.components[1]),
    ).toBe(true);
    expect(() =>
      defineInformationModule({
        ...definition,
        manifest: {
          ...definition.manifest,
          inspection: {
            ...inspection,
            surface: {
              ...inspection.surface,
              components: [
                inspection.surface.components[0]!,
                { ...inspection.surface.components[0]! },
              ],
            },
          },
        },
      }),
    ).toThrow(/Duplicate inspection surface component/);
    expect(() =>
      defineInformationModule({
        ...definition,
        manifest: {
          ...definition.manifest,
          inspection: {
            ...inspection,
            surface: {
              ...inspection.surface,
              components: inspection.surface.components.map((component) =>
                component.type === "status-summary"
                  ? { ...component, viewId: "missing" }
                  : component,
              ),
            },
          },
        },
      }),
    ).toThrow(/Unknown inspection surface view/);
  });

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
        summary: "Test information module.",
        moduleVersion: "1.0.0",
        selectors: [],
        promptRenderers: [],
        requires: [],
        provides: [],
        diagnostics: [diagnostic],
        definitionId: "acme.diagnostics",
        displayName: "Diagnostics",
        description: "Defines the Diagnostics information module.",
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
          summary: "Test information module.",
          moduleVersion: "1.0.0",
          selectors: [],
          promptRenderers: [],
          requires: [],
          provides: [],
          definitionId: "acme.duplicate",
          displayName: "Duplicate",
          description: "Defines the Duplicate information module.",
          settingsSchema: z.object({}).strict(),
          consumes: [inputKind, inputKind],
          produces: [inputKind, inputKind],
        },
        create: () => ({ provisions: [], subscriptions: [] }),
      }),
    ).toThrow(`Duplicate information module consumes: ${inputKind.kind}`);
  });
});
