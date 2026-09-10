import { describe, expect, it } from "vitest";

import { executionExhaustedInformationKind } from "@kaguya/engine";
import { z } from "@kaguya/schema";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";

import {
  createFirstPartyModuleActivations,
  createFirstPartyModuleCatalog,
  createFirstPartyModuleConfigDefaults,
} from "./catalog.js";

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
});
