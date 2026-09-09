/**
 * 架构说明：本测试覆盖信息 kind 的定义校验、引用规则快照、日志策略冻结，以及 pipe
 * schema 中共享子 schema 的非递归复用，确保 SDK 在 Core 启动前提供一致的可注册契约。
 * 代码库关系：这些测试直接消费 `packages/sdk/src/index.ts` 的公开导出，
 * 以避免新的 kind contract 只存在于内部实现而未进入公共 API。
 */
import { z } from "@kaguya/schema";
import { describe, expect, it } from "vitest";

import {
  defineInformationKind,
  type InformationRegistrationInput,
} from "./index.js";

describe("defineInformationKind", () => {
  it("exposes registration input without a duplicate kind or information id", () => {
    const input: InformationRegistrationInput<
      "acme.message.created",
      { text: string }
    > = {
      occurredAt: "2026-09-04T00:00:00.000Z",
      source: "adapter:test",
      payload: { text: "moon" },
      references: [],
    };

    expect(input).toEqual({
      occurredAt: "2026-09-04T00:00:00.000Z",
      source: "adapter:test",
      payload: { text: "moon" },
      references: [],
    });
  });

  it("requires a schema, declared references, and explicit logging", () => {
    const definition = defineInformationKind({
      kind: "acme.message.created",
      displayName: "Acme Message Created",
      description: "Information carried by the acme.message.created kind.",
      payloadSchema: z.object({ text: z.string() }).strict(),
      references: {
        "acme:parent": {
          required: true,
          multiple: false,
          targetKinds: ["acme.message.parent"],
        },
      },
      log: { enabled: false },
    });

    expect(Object.isFrozen(definition)).toBe(true);
    expect(Object.isFrozen(definition.references)).toBe(true);
    expect(definition.references["acme:parent"]?.targetKinds).toEqual([
      "acme.message.parent",
    ]);
  });

  it("requires non-empty display metadata", () => {
    const input = {
      kind: "acme.message.created",
      displayName: "Created message",
      description: "A message accepted by Acme.",
      payloadSchema: z.object({}).strict(),
      references: {},
      log: { enabled: false } as const,
    };

    expect(() =>
      defineInformationKind({ ...input, displayName: "  " }),
    ).toThrow(/display name/iu);
    expect(() =>
      defineInformationKind({ ...input, description: "  " }),
    ).toThrow(/description/iu);
  });

  it("freezes an explicitly classified debug detail projector", () => {
    const definition = defineInformationKind({
      kind: "acme.prompt.requested",
      displayName: "Acme Prompt Requested",
      description: "Information carried by the acme.prompt.requested kind.",
      payloadSchema: z.object({ text: z.string() }).strict(),
      references: {},
      log: {
        enabled: true,
        level: "info",
        project: () => ({ event: "prompt.requested" }),
        detail: {
          sensitivity: "content",
          project: ({ payload }) => ({ promptFull: payload.text }),
        },
      },
    });

    expect(definition.log).toMatchObject({
      enabled: true,
      detail: { sensitivity: "content" },
    });
    if (definition.log.enabled)
      expect(Object.isFrozen(definition.log.detail)).toBe(true);
    expect(() =>
      defineInformationKind({
        kind: "acme.prompt.invalid-detail",
        displayName: "Acme Prompt Invalid Detail",
        description:
          "Information carried by the acme.prompt.invalid-detail kind.",
        payloadSchema: z.object({}).strict(),
        references: {},
        log: {
          enabled: true,
          level: "info",
          project: () => ({}),
          detail: { sensitivity: "secret" as never, project: () => ({}) },
        },
      }),
    ).toThrow(/detail sensitivity/);
  });

  it("accepts a shared schema reused by separate fields inside a pipe", () => {
    const sharedSource = z.enum(["template", "history"]);
    const input = z
      .object({ first: sharedSource, second: sharedSource })
      .strict();
    const output = z
      .object({
        first: z.enum(["template", "history"]),
        second: z.enum(["template", "history"]),
      })
      .strict();

    expect(() =>
      defineInformationKind({
        kind: "acme.prompt.created",
        displayName: "Acme Prompt Created",
        description: "Information carried by the acme.prompt.created kind.",
        payloadSchema: z.object({ value: input.pipe(output) }).strict(),
        references: {},
        log: { enabled: false },
      }),
    ).not.toThrow();
  });

  it("rejects malformed relation names", () => {
    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.object({}).strict(),
        references: { parent: { required: false, multiple: false } },
        log: { enabled: false },
      }),
    ).toThrow(/namespace/iu);
  });

  it("rejects non-Zod payload schemas", () => {
    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: undefined as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/zod schema/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: {
          parse: () => ({}) as never,
        } as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/zod schema/iu);
  });

  it("rejects schemas that do not enforce a strict JSON object contract", () => {
    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.string() as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/json object/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.array(z.string()) as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/json object/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.object({ text: z.string() }) as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/strict/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.object({ when: z.date() }).strict() as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/date|json object/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.object({ total: z.bigint() }).strict() as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/bigint|json object/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z
          .object({
            items: z.array(
              z
                .object({
                  when: z.date(),
                })
                .strict(),
            ),
          })
          .strict() as never,
        references: {},
        log: { enabled: false },
      }),
    ).toThrow(/date|json object/iu);
  });

  it("rejects duplicate target kinds and empty target kind lists", () => {
    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.object({}).strict(),
        references: {
          "acme:parent": {
            required: true,
            multiple: false,
            targetKinds: [],
          },
        },
        log: { enabled: false },
      }),
    ).toThrow(/must not be empty/iu);

    expect(() =>
      defineInformationKind({
        kind: "acme.message.created",
        displayName: "Acme Message Created",
        description: "Information carried by the acme.message.created kind.",
        payloadSchema: z.object({}).strict(),
        references: {
          "acme:parent": {
            required: true,
            multiple: false,
            targetKinds: ["acme.message.parent", "acme.message.parent"],
          },
        },
        log: { enabled: false },
      }),
    ).toThrow(/duplicates/iu);
  });
});
