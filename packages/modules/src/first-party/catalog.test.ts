import { describe, expect, it } from "vitest";

import { executionExhaustedInformationKind } from "@kaguya/engine";
import { z } from "@kaguya/schema";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";

import {
  createFirstPartyModuleActivations,
  createFirstPartyModuleCatalog,
  createFirstPartyModuleConfigDefaults,
} from "./catalog.js";

const testIdentity = { name: "Kaguya", aliases: ["辉夜"], persona: "test" };
const testReplyTemplates = {
  main: "{{scene}}{{history}}{{memory}}{{quoted}}{{target}}",
  history: "{{#each messages}}{{> history-inbound}}{{/each}}",
  historyInbound: "{{content}}",
  historyAssistant: "{{content}}",
  memory: "{{#each items}}{{> memory-item}}{{/each}}",
  memoryItem: "{{content}}",
  quoted: "{{message}}",
  target: "{{content}}",
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
    promptTemplates: testReplyTemplates,
    agentIdentity: testIdentity,
  });
}

describe("first-party module configuration", () => {
  it("materializes six complete v1 defaults and activates enabled instances", () => {
    const defaults = createFirstPartyModuleConfigDefaults("production");
    expect(defaults).toHaveLength(6);
    expect(
      defaults.every(({ version, enabled }) => version === 1 && enabled),
    ).toBe(true);
    expect(createFirstPartyModuleActivations(catalog(), defaults)).toHaveLength(
      6,
    );
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
