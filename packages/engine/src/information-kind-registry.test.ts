/**
 * 架构说明：本测试覆盖信息 kind registry 的封锁、保留命名空间与快照语义，
 * 保证 Core 启动前的注册过程具备明确的失败边界。
 * 代码库关系：这些测试直接验证 `packages/engine/src/index.ts` 计划导出的
 * registry 公共 API，并为后续 core 启动和 storage 同步建立基线。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
import { describe, expect, it } from "vitest";

import {
  DuplicateInformationKindError,
  InformationKindRegistry,
  InformationRegistrySealedError,
  ReservedInformationKindError,
  UnknownInformationKindError,
} from "./information-kind-registry.js";

const customDefinition = defineInformationKind({
  kind: "acme.message.created",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const otherDefinition = defineInformationKind({
  kind: "acme.message.updated",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const coreDefinition = defineInformationKind({
  kind: "core.message.created",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

describe("InformationKindRegistry", () => {
  it("rejects duplicate, unknown, reserved, and post-seal registrations", () => {
    const registry = new InformationKindRegistry();
    registry.register(customDefinition);
    expect(() => registry.register(customDefinition)).toThrow(
      DuplicateInformationKindError,
    );
    expect(() => registry.get("acme.unknown")).toThrow(
      UnknownInformationKindError,
    );
    expect(() => registry.register(coreDefinition)).toThrow(
      ReservedInformationKindError,
    );
    registry.seal();
    expect(() => registry.register(otherDefinition)).toThrow(
      InformationRegistrySealedError,
    );
  });

  it("accepts builtins only from the core namespace and exposes frozen snapshots", () => {
    const registry = new InformationKindRegistry();
    registry.registerBuiltin(coreDefinition);
    expect(registry.get(coreDefinition.kind)).toBe(coreDefinition);

    const definitions = registry.definitions();
    expect(definitions).toEqual([coreDefinition]);
    expect(Object.isFrozen(definitions)).toBe(true);
    expect(() => {
      (definitions as unknown as Array<unknown>).push(customDefinition);
    }).toThrow();
    expect(() => registry.registerBuiltin(customDefinition)).toThrow(
      ReservedInformationKindError,
    );
  });
});
