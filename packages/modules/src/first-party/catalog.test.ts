/**
 * 功能概述：验证 first-party Catalog 默认配置及激活边界。
 * 主要职责：catalog fixture 注入宿主能力与共享 kind，测试八个默认模块、严格 modelTier 设置、
 * disabled 配置校验与旧 reply/outbound 配置拒绝；Profile 身份决定 Heartflow botNames。
 * 检查视图只引用 Catalog 中的模块 Kind，或由 model-task 能力及请求 Surface 明确声明的 Runtime 请求 Kind。
 * 代码库关系：直接约束 catalog 工厂以及 message-composer 模块的公开 settings schema。
 * 输入输出与副作用：纯内存组装，不连接模型或数据库；错误包含重新初始化说明。
 */
import { describe, expect, it } from "vitest";

import { executionExhaustedInformationKind } from "@kaguya/engine";
import { z } from "@kaguya/schema";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";

import {
  createFirstPartyModuleActivations,
  createFirstPartyModuleCatalog,
  createFirstPartyModuleConfigDefaults,
} from "./catalog.js";

const testIdentity = {
  name: "Kaguya",
  aliases: ["辉夜"],
  persona: "test",
  timeZone: "Asia/Shanghai",
};
const testMessageTemplates = {
  main: "{{scene}}{{history}}{{memory}}{{turn}}",
  history: "{{#each messages}}{{> history-inbound}}{{/each}}",
  historyInbound: "{{content}}",
  historyAssistant: "{{content}}",
  memory: "{{#each items}}{{> memory-item}}{{/each}}",
  memoryItem: "{{content}}",
  quoted: "{{message}}",
  turn: "{{#each messages}}{{> history-inbound}}{{/each}}",
  plan: "{{topic}} {{reply_act}}",
};

function catalog() {
  const kind = (name: string) =>
    defineInformationKind({
      kind: name,
      displayName: name,
      description: name,
      payloadSchema: z.object({}).strict(),
      references: {},
      log: { enabled: false },
    });
  return createFirstPartyModuleCatalog({
    modelTaskCapability: defineModuleCapability(
      "kaguya:model-task",
      1,
    ) as never,
    modelTaskCompletedInformationKind: kind(
      "core.model.task.completed",
    ) as never,
    modelTaskFailedInformationKind: kind("core.model.task.failed") as never,
    modelTaskCancelledInformationKind: kind(
      "core.model.task.cancelled",
    ) as never,
    deliveryDeliveredInformationKind: kind("core.delivery.delivered") as never,
    deliveryFailedInformationKind: kind("core.delivery.failed") as never,
    executionExhaustedInformationKind,
    promptTemplates: testMessageTemplates,
    agentIdentity: testIdentity,
  });
}

describe("first-party module configuration", () => {
  it("declares useful domain inspection for every first-party definition and only registered kinds", () => {
    const definitions = catalog().definitions;
    const kinds = new Set(
      definitions
        .flatMap((d) => [...d.manifest.produces, ...d.manifest.consumes])
        .map((k) => k.kind),
    );
    expect(definitions).toHaveLength(12);
    for (const { manifest } of definitions) {
      expect(manifest.inspection?.mechanism.length).toBeGreaterThan(0);
      expect(manifest.inspection?.views.length).toBeGreaterThan(0);
      expect(Object.isFrozen(manifest.inspection)).toBe(true);
      for (const view of manifest.inspection!.views) {
        expect(Object.isFrozen(view.fields)).toBe(true);
        expect(Object.isFrozen(view.fields[0])).toBe(true);
        expect(view.fields.length).toBeGreaterThan(0);
        for (const kind of view.kinds) {
          if (kind === "core.model.task.requested") {
            // 请求由 Runtime 注册，业务模块无需为了检查页面而声明消费或生产。
            expect(manifest.requires).toContainEqual({
              id: "kaguya:model-task",
              apiVersion: 1,
            });
            expect(manifest.inspection!.surface?.components).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  type: "model-request-browser",
                  viewId: view.id,
                }),
              ]),
            );
          } else {
            expect(kinds.has(kind), kind).toBe(true);
          }
        }
      }
    }
  });
  it("materializes eight complete v1 defaults and activates enabled instances", () => {
    const defaults = createFirstPartyModuleConfigDefaults("production");
    expect(defaults).toHaveLength(8);
    expect(
      defaults.every(({ version, enabled }) => version === 1 && enabled),
    ).toBe(true);
    expect(createFirstPartyModuleActivations(catalog(), defaults)).toHaveLength(
      8,
    );
  });

  it("uses only modelTier for the default message composer", () => {
    expect(createFirstPartyModuleConfigDefaults()[0]).toEqual({
      version: 1,
      instanceId: "message-composer.default",
      definitionId: "agent.message-composer",
      enabled: true,
      settings: { modelTier: "heavy" },
    });
  });

  it.each([
    { instanceId: "reply.default", definitionId: "demo.reply.llm" },
    {
      settings: {
        modelTier: "heavy",
        outbound: { mode: "source", messageKind: "reply" },
      },
    },
    {
      settings: {
        modelTier: "heavy",
        outbound: {
          mode: "fixed",
          adapterId: "qq",
          platform: "qq",
          destination: { kind: "group", groupId: "1" },
        },
      },
    },
  ])(
    "rejects legacy configuration with reinitialization guidance",
    (legacy) => {
      const defaults = createFirstPartyModuleConfigDefaults();
      expect(() =>
        createFirstPartyModuleActivations(catalog(), [
          { ...defaults[0]!, ...legacy, enabled: false },
          ...defaults.slice(1),
        ]),
      ).toThrow(/Reinitialize module configuration/);
    },
  );

  it("exposes only the message intent protocol across catalog definitions", () => {
    const definitions = catalog().definitions;
    expect(definitions.map(({ manifest }) => manifest.definitionId)).toContain(
      "agent.message-composer",
    );
    expect(
      definitions.map(({ manifest }) => manifest.definitionId),
    ).not.toContain("demo.reply.llm");
    const kinds = definitions
      .flatMap(({ manifest }) => [...manifest.consumes, ...manifest.produces])
      .map(({ kind }) => kind);
    expect(kinds).toContain("agent.message.intent.requested");
    expect(kinds).not.toContain("core.reply.requested");
  });

  it("validates complete settings even for disabled instances", () => {
    const defaults = createFirstPartyModuleConfigDefaults("production");
    const disabled = defaults.map((item) =>
      item.instanceId === "heartbeat.default"
        ? { ...item, enabled: false, settings: {} }
        : item,
    );
    expect(() =>
      createFirstPartyModuleActivations(catalog(), disabled),
    ).toThrow();
  });

  it("does not activate a valid disabled instance", () => {
    const defaults = createFirstPartyModuleConfigDefaults("production");
    const disabled = defaults.map((item) =>
      item.instanceId === "heartbeat.default"
        ? { ...item, enabled: false }
        : item,
    );
    expect(
      createFirstPartyModuleActivations(catalog(), disabled).some(
        ({ instanceId }) => instanceId === "heartbeat.default",
      ),
    ).toBe(false);
  });

  it("uses Profile identity as the only effective Heartflow bot-name source", () => {
    const customIdentity = {
      name: "Luna",
      aliases: ["月"],
      persona: "test",
      timeZone: "Asia/Shanghai",
    };
    const defaults = createFirstPartyModuleConfigDefaults(
      "production",
      customIdentity,
    );
    const legacy = defaults.map((item) =>
      item.definitionId === "agent.heartflow.online"
        ? { ...item, settings: { ...item.settings, botNames: ["Legacy"] } }
        : item,
    );
    const heartflow = createFirstPartyModuleActivations(
      catalog(),
      legacy,
      customIdentity,
    ).find(({ definitionId }) => definitionId === "agent.heartflow.online");
    expect(heartflow?.settings).toMatchObject({ botNames: ["Luna", "月"] });
  });
});
