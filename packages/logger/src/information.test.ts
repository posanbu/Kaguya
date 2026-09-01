/**
 * 架构说明：本测试覆盖信息原子日志投影的正文预览、身份回填、
 * 级别路由与失败汇报，确保日志路径不会泄漏敏感负载字段。
 * 代码库关系：`packages/logger/src/information.ts` 的公开契约在这里被锁定，
 * `packages/logger/src/index.ts` 的导出只应增加而不破坏既有 logger 行为。
 */
import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { z, type InformationAtom, type JsonObject } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import { createLogger } from "./index.js";
import {
  MAX_INFORMATION_CONTENT_CODE_POINTS,
  createInformationAtomLogSink,
  previewInformationContent,
  projectInformationAtomLog,
} from "./information.js";

type TextPayload = {
  content: string;
  prompt: string;
  response: string;
  credentials: string;
  raw: string;
  headers: string;
};

type ContentPayload = {
  content: string;
};

const textPayloadSchema = z
  .object({
    content: z.string(),
    prompt: z.string(),
    response: z.string(),
    credentials: z.string(),
    raw: z.string(),
    headers: z.string(),
  })
  .strict();

describe("information atom log projection", () => {
  it("exposes the 168 code point ceiling", () => {
    expect(MAX_INFORMATION_CONTENT_CODE_POINTS).toBe(168);
  });

  it.each([
    ["月".repeat(167), 167, false, "月".repeat(167)],
    ["月".repeat(168), 168, false, "月".repeat(168)],
    ["月".repeat(169), 169, true, `${"月".repeat(168)}…`],
  ])(
    "truncates by Unicode code point",
    (input, length, truncated, preview) => {
      expect(previewInformationContent(input)).toEqual({
        contentPreview: preview,
        contentLength: length,
        contentTruncated: truncated,
      });
    },
  );

  it("preserves newline and escapes C0 controls", () => {
    expect(
      previewInformationContent(`line 1\nline 2\t${String.fromCharCode(0)}${String.fromCharCode(31)}end`),
    ).toEqual({
      contentPreview: `line 1\nline 2\t\\u0000\\u001fend`,
      contentLength: 19,
      contentTruncated: false,
    });
  });

  it("projects the atom identity and body preview without leaking payload fields", async () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      level: "trace",
      stream,
    });
    const definition = defineInformationKind<"core.message.inbound.text", TextPayload>({
      kind: "core.message.inbound.text",
      payloadSchema: textPayloadSchema,
      references: {},
      log: {
        enabled: true,
        level: "info",
        project(atom) {
          return {
            contentPreview: previewInformationContent(atom.payload.content).contentPreview,
            contentLength: previewInformationContent(atom.payload.content).contentLength,
            contentTruncated: previewInformationContent(atom.payload.content).contentTruncated,
            informationId: "spoofed",
            kind: "spoofed.kind",
            occurredAt: "1999-01-01T00:00:00.000Z",
            source: "spoofed:source",
          };
        },
      },
    });
    const atom: InformationAtom<"core.message.inbound.text", TextPayload> = {
      informationId: "atom-1",
      kind: "core.message.inbound.text",
      occurredAt: "2026-09-01T12:00:00.000Z",
      source: "runtime:web",
      payload: {
        content: "hello moon",
        prompt: "private prompt",
        response: "private response",
        credentials: "private credentials",
        raw: "private raw",
        headers: "private headers",
      },
      references: [],
    };

    await projectInformationAtomLog(logger, definition, atom);

    expect(stream.logs()).toEqual([
      expect.objectContaining({
        informationId: "atom-1",
        kind: "core.message.inbound.text",
        occurredAt: "2026-09-01T12:00:00.000Z",
        source: "runtime:web",
        contentPreview: "hello moon",
        contentLength: 10,
        contentTruncated: false,
      }),
    ]);
    const serialized = JSON.stringify(stream.logs());
    expect(serialized).not.toContain("private prompt");
    expect(serialized).not.toContain("private response");
    expect(serialized).not.toContain("private credentials");
    expect(serialized).not.toContain("private raw");
    expect(serialized).not.toContain("private headers");
  });

  it.each([
    ["debug" as const],
    ["info" as const],
    ["warn" as const],
    ["error" as const],
  ])("routes each log level through the matching pino method: %s", async (level) => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      level: "trace",
      stream,
    });
    const definition = defineInformationKind<`core.system.log.${typeof level}`, ContentPayload>({
      kind: `core.system.log.${level}`,
      payloadSchema: z
        .object({
          content: z.string(),
        })
        .strict(),
      references: {},
      log: {
        enabled: true,
        level,
        project(atom) {
          return {
            contentPreview: previewInformationContent(atom.payload.content).contentPreview,
          };
        },
      },
    });
    const atom: InformationAtom<`core.system.log.${typeof level}`, ContentPayload> = {
      informationId: `atom-${level}`,
      kind: `core.system.log.${level}`,
      occurredAt: "2026-09-01T12:00:00.000Z",
      source: "runtime:core",
      payload: { content: `body-${level}` },
      references: [],
    };

    await projectInformationAtomLog(logger, definition, atom);

    expect(stream.logs()[0]).toMatchObject({
      level,
      informationId: `atom-${level}`,
      contentPreview: `body-${level}`,
    });
  });

  it("disables logging when the policy is disabled", async () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      level: "trace",
      stream,
    });
    const definition = defineInformationKind<"core.system.log.disabled", ContentPayload>({
      kind: "core.system.log.disabled",
      payloadSchema: z
        .object({
          content: z.string(),
        })
        .strict(),
      references: {},
      log: {
        enabled: false,
      },
    });
    const atom: InformationAtom<"core.system.log.disabled", ContentPayload> = {
      informationId: "atom-disabled",
      kind: "core.system.log.disabled",
      occurredAt: "2026-09-01T12:00:00.000Z",
      source: "runtime:core",
      payload: { content: "body-disabled" },
      references: [],
    };

    await projectInformationAtomLog(logger, definition, atom);

    expect(stream.logs()).toEqual([]);
  });

  it("reports invalid projector results without throwing", async () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      level: "trace",
      stream,
    });
    const definition = defineInformationKind<"core.system.log.invalid", ContentPayload>({
      kind: "core.system.log.invalid",
      payloadSchema: z
        .object({
          content: z.string(),
        })
        .strict(),
      references: {},
      log: {
        enabled: true,
        level: "info",
        project() {
          return null as unknown as JsonObject;
        },
      },
    });
    const atom: InformationAtom<"core.system.log.invalid", ContentPayload> = {
      informationId: "atom-invalid",
      kind: "core.system.log.invalid",
      occurredAt: "2026-09-01T12:00:00.000Z",
      source: "runtime:core",
      payload: { content: "body-invalid" },
      references: [],
    };
    const errors: unknown[] = [];

    await expect(
      projectInformationAtomLog(logger, definition, atom, (error) => {
        errors.push(error);
      }),
    ).resolves.toBeUndefined();

    expect(errors).toEqual([
      {
        informationId: "atom-invalid",
        kind: "core.system.log.invalid",
        errorType: "invalid_projection_result",
      },
    ]);
    expect(stream.logs()).toEqual([]);
  });

  it("creates a sink that resolves definitions by atom kind", async () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      level: "trace",
      stream,
    });
    const definition = defineInformationKind<"core.system.log.sink", ContentPayload>({
      kind: "core.system.log.sink",
      payloadSchema: z
        .object({
          content: z.string(),
        })
        .strict(),
      references: {},
      log: {
        enabled: true,
        level: "info",
        project(atom) {
          return {
            contentPreview: previewInformationContent(atom.payload.content).contentPreview,
          };
        },
      },
    });
    const sink = createInformationAtomLogSink({
      logger,
      definitions: [definition],
    });

    await sink({
      informationId: "atom-sink",
      kind: "core.system.log.sink",
      occurredAt: "2026-09-01T12:00:00.000Z",
      source: "runtime:core",
      payload: { content: "sink-body" },
      references: [],
    });

    expect(stream.logs()[0]).toMatchObject({
      informationId: "atom-sink",
      kind: "core.system.log.sink",
      contentPreview: "sink-body",
    });
  });

  it("reports unknown kinds from a sink", async () => {
    const stream = new MemoryStream();
    const logger = createLogger({
      service: "kaguya-test",
      level: "trace",
      stream,
    });
    const errors: unknown[] = [];
    const sink = createInformationAtomLogSink({
      logger,
      definitions: [],
      emergencyReporter(error) {
        errors.push(error);
      },
    });

    await sink({
      informationId: "atom-unknown",
      kind: "core.system.log.unknown",
      occurredAt: "2026-09-01T12:00:00.000Z",
      source: "runtime:core",
      payload: { content: "unknown-body" },
      references: [],
    });

    expect(errors).toEqual([
      {
        informationId: "atom-unknown",
        kind: "core.system.log.unknown",
        errorType: "unknown_information_kind",
      },
    ]);
    expect(stream.logs()).toEqual([]);
  });
});

class MemoryStream extends Writable {
  readonly #chunks: string[] = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.#chunks.push(chunk.toString());
    callback();
  }

  logs(): Record<string, unknown>[] {
    return this.#chunks
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }
}
