/**
 * 功能概述：验证终端排版在可读性、插件扩展、无颜色环境和敏感字段上的边界。
 * 主要职责：通过 prettyFactory 覆盖真实 Pino prettifier；同步子进程覆盖 createLogger 到
 * stdout/stderr 的完整 serializer → redaction → pretty 链路及 JSON 对照，不启动业务服务。
 * 代码库关系：覆盖 pretty.ts 的展示词表、正文与溯源分离，以及 index.ts 对终端输出的接线。
 * 输入输出与副作用：内存样例与隔离子进程，不写业务数据库，不依赖 sleep 或异步轮询。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { prettyFactory } from "pino-pretty";
import { describe, expect, it } from "vitest";

import {
  createPrettyOptions,
  formatPrettyMessage,
  supportsPrettyColors,
} from "./pretty.js";

describe("console presentation", () => {
  it("puts the human summary before readable startup fields without a JSON dump", () => {
    const rendered = prettyFactory(createPrettyOptions())({
      time: "2026-09-19T10:20:30.000Z",
      level: "info",
      service: "kaguya",
      module: "server",
      event: "server.started",
      msg: "Kaguya server started",
      host: "127.0.0.1",
      port: 3000,
      runtimeReady: false,
      adapterHostState: "degraded",
      degradationReasons: ["database_unavailable"],
    });
    expect(rendered).toMatch(
      /^\[\d{2}:\d{2}:30\] INFO: \[主程序\] Kaguya 服务已启动\n/u,
    );
    expect(rendered).toContain("运行时=未就绪");
    expect(rendered).toContain("适配器状态=降级");
    expect(rendered).toContain("database_unavailable");
    expect(rendered).toContain("event=server.started");
    expect(rendered).not.toContain('"host":');
    expect(rendered).not.toContain("2026-09-19T10:20:30");
  });

  it.each([
    ["submitted", "已提交处理"],
    ["filtered", "已被过滤"],
    ["failed", "提交失败"],
  ])(
    "distinguishes inbound %s and retains every message line",
    (stage, label) => {
      const message = "你好，辉夜 🌙\n第二行消息";
      const output = formatPrettyMessage({
        module: "adapter:napcat",
        event: `napcat.inbound.${stage}`,
        msg: "Adapter inbound message",
        senderId: "user-1",
        targetKind: "group",
        messageText: message,
      });
      expect(output).toContain(`[NapCat] 收到消息 · ${label}`);
      expect(output).toContain("消息接收 · 输入");
      expect(output).toContain("消息正文");
      expect(output).toMatch(/│\s+你好，辉夜 🌙[^\n]*\n\s+│\s+第二行消息/u);
      expect(output).toContain("发送者=user-1 · 会话类型=群聊");
      expect(output.match(/你好/gu)).toHaveLength(1);
    },
  );

  it("does not mislabel generated replies as delivered or failed model tasks as complete", () => {
    expect(
      formatPrettyMessage({
        event: "message.assistant",
        contentPreview: "你好",
      }),
    ).toContain("回复已生成");
    expect(
      formatPrettyMessage({ event: "delivery.lifecycle", status: "delivered" }),
    ).toContain("消息投递 · 已送达");
    const output = formatPrettyMessage({
      event: "model.task.lifecycle",
      status: "failed",
      durationMs: 1254,
      errorKind: "retryable",
      failureStage: "task-schema-validation",
      structuredOutputFailure: "schema-mismatch",
      attemptCount: 2,
    });
    expect(output).toContain("模型任务 · 失败");
    expect(output).toContain("耗时=1.25 s");
    expect(output).toContain("失败阶段=task-schema-validation");
    expect(output).toContain("structuredOutputFailure=schema-mismatch");
    expect(output).toContain("尝试次数=2");
  });

  it("keeps specific startup descriptions, unknown plugin events and custom fields", () => {
    expect(
      formatPrettyMessage({
        module: "runtime:modules",
        event: "module.started",
        msg: "已加载 12 条记忆",
      }),
    ).toContain("[模块] 已加载 12 条记忆");
    const output = formatPrettyMessage({
      module: "runtime:module:plugin.custom",
      event: "plugin.ready",
      msg: "Information module custom status",
      count: 0,
      enabled: false,
      extra: { nested: ["值", 1] },
    });
    expect(output).toContain(
      "[plugin.custom] Information module custom status",
    );
    expect(output).toContain("event=plugin.ready");
    expect(output).toContain("数量=0 · enabled=否");
    expect(output).toContain('extra:\n      nested=["值",1]');
    expect(
      formatPrettyMessage({ module: "toString", event: "constructor" }),
    ).toBe("[toString] constructor");
    expect(
      formatPrettyMessage({ event: "napcat.inbound.constructor" }),
    ).toContain("收到消息 · constructor");
    expect(formatPrettyMessage({ event: "web.inbound.__proto__" })).toContain(
      "收到消息 · __proto__",
    );
  });

  it("keeps full trace fields and preserves standalone or malformed DAG fields", () => {
    const output = formatPrettyMessage({
      informationId: "information-root",
      kind: "test.kind",
      references: [{ relation: "core:context", informationId: "context-root" }],
      requestId: "request-full-id",
      rootInformationId: "root-full-id",
      source: "custom-source",
      occurredAt: "2026-09-19T00:00:00Z",
    });
    expect(output).toContain("[informat] test.kind ← core:context:context-");
    expect(output).toContain("requestId=request-full-id");
    expect(output).toContain("rootInformationId=root-full-id");
    expect(output).toContain("occurredAt=2026-09-19T00:00:00Z");
    expect(
      formatPrettyMessage({ informationId: "standalone-full-id" }),
    ).toContain("informationId=standalone-full-id");
    expect(
      formatPrettyMessage({
        informationId: "id",
        kind: "kind",
        references: [{ custom: true }],
      }),
    ).toContain("references:\n    - custom=是");
  });

  it("retains Prompt detail and provenance without mutating the input", () => {
    const record = {
      event: "model.task.prompt",
      detail: true,
      promptFull: "System\nUser 🌙",
      promptVariables: [
        {
          variableName: "history",
          informationIds: ["information-root"],
          contentDigest: "sha256:test",
        },
      ],
      sensitivity: "content",
    };
    const original = structuredClone(record);
    const output = formatPrettyMessage(record);
    expect(output).toContain("模型任务 · 输入 Prompt");
    expect(output).toMatch(/│\s+System[^\n]*\n\s+│\s+User 🌙/u);
    expect(output).toContain("history information=informat digest=sha256:test");
    expect(output).toContain("detail=true");
    expect(output).toContain("sensitivity=content");
    expect(record).toEqual(original);
    expect(formatPrettyMessage({ ...record, detail: false })).not.toContain(
      "System",
    );
    expect(formatPrettyMessage({ ...record, detail: false })).not.toContain(
      "sha256:test",
    );
  });

  it("escapes terminal controls in messages, metadata and unknown field names", () => {
    const output = formatPrettyMessage({
      module: "custom\u001b[31m",
      msg: "first\rFORGED\nsecond",
      messageText: "\u001b]8;;https://example.invalid\u0007link\u001b[0m",
      source: "first\nFORGED",
      "key\nFORGED": "value\u009b31m",
    });
    expect(output).not.toMatch(/[\u001b\u0007\u000d\u009b]/u);
    expect(output).toContain("first\\u000dFORGED\n    second");
    expect(output).toContain("source=first\\nFORGED");
    expect(output).toContain("key\\nFORGED=value\\u009b31m");
    expect(
      output
        .split("\n")
        .slice(1)
        .every((line) => line.startsWith("  ")),
    ).toBe(true);
  });

  it("uses stable module colors and leaves body text plain", () => {
    const record = {
      time: 0,
      level: "warn",
      module: "adapter:napcat",
      event: "napcat.connection.disconnected",
    };
    const plain = prettyFactory(createPrettyOptions(false))(record)!;
    const colored = prettyFactory(createPrettyOptions(true))(record)!;
    expect(colored).toContain("\u001b[33mWARN\u001b[0m");
    expect(colored).toContain("[NapCat]\u001b[0m 连接状态");
    expect(stripVTControlCharacters(colored)).toBe(plain);
    expect(colored).toBe(prettyFactory(createPrettyOptions(true))(record));
    expect(plain).not.toContain("\u001b");
    expect(supportsPrettyColors(true, {})).toBe(true);
    expect(supportsPrettyColors(undefined, {})).toBe(false);
    expect(supportsPrettyColors(false, { FORCE_COLOR: "1" })).toBe(false);
    expect(supportsPrettyColors(true, { NO_COLOR: "" })).toBe(false);
    expect(supportsPrettyColors(true, { TERM: "dumb" })).toBe(false);
  });

  it("does not let legacy top-level Error records bypass control escaping or print twice", () => {
    const output = prettyFactory(createPrettyOptions(false))({
      level: "error",
      event: "plugin.failure",
      type: "Error",
      stack: "\u001b[31munsafe-stack\rOVERRIDE\u001b[0m",
      custom: "preserve",
    })!;
    expect(output).not.toMatch(/[\u001b\r]/u);
    expect(output.match(/unsafe-stack/gu)).toHaveLength(1);
    expect(output).toContain("type=Error");
    expect(output).toContain("custom=preserve");
    expect(output).toContain("\\u000dOVERRIDE");
  });

  it("escapes pino metadata and timestamps without duplicate rendering", () => {
    const pretty = prettyFactory(createPrettyOptions(false));
    const output = pretty({
      level: "info",
      event: "plugin.event",
      name: "\u001b[31munsafe-name\rRESET",
      caller: "\u001b[31munsafe-caller\rRESET",
      time: "\u001b[31munsafe-time\rRESET",
    })!;
    expect(output).not.toMatch(/[\u001b\r]/u);
    for (const field of ["name", "caller", "time"]) {
      expect(output.match(new RegExp(`unsafe-${field}`, "gu"))).toHaveLength(1);
    }
    expect(output).toContain("\\u000dRESET");
    expect(pretty({ level: "info", time: Date.now(), msg: "normal" })).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] INFO/u,
    );
  });

  it.each([1, 2])(
    "runs the production pretty pipeline on fd %s after redaction",
    (destination) => {
      const result = runLogger("pretty", destination);
      expect(result.status).toBe(0);
      const output = destination === 1 ? result.stdout : result.stderr;
      expect(destination === 1 ? result.stderr : result.stdout).toBe("");
      expect(output).toContain("[NapCat] 收到消息 · 已提交处理");
      expect(output).toContain("正文安全样例");
      expect(output).toContain("╭─ 消息接收 · 输入");
      expect(output).toContain("[REDACTED]");
      expect(output).not.toMatch(
        /secret-value|private-prompt|unsafe-error-message|hidden-headers|\u001b/u,
      );
      expect(output).toContain("TEST_FAILURE");
      expect(output).toContain("/healthz");
    },
  );

  it("keeps JSON keys, event codes, full IDs and error summaries unchanged", () => {
    const result = runLogger("json", 1);
    expect(result.status).toBe(0);
    const [inbound, failure] = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(inbound).toMatchObject({
      module: "adapter:napcat",
      event: "napcat.inbound.submitted",
      level: "info",
      messageText: "正文安全样例",
      rootInformationId: "019921ab-cdef-7000-8000-000000000001",
      token: "[REDACTED]",
      prompt: "[REDACTED]",
    });
    expect(failure).toMatchObject({
      err: { type: "Error", code: "TEST_FAILURE" },
      req: { path: "/healthz" },
    });
    expect(result.stdout).not.toMatch(
      /secret-value|private-prompt|unsafe-error-message|hidden-headers|\u001b/u,
    );
  });
});

function runLogger(format: string, destination: number) {
  const entry = new URL("./index.ts", import.meta.url).href;
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    import { createLogger, createModuleLogger, closeLogger } from ${JSON.stringify(entry)};
    const root = createLogger({ service: "test", format: ${JSON.stringify(format)}, destination: ${destination} });
    const logger = createModuleLogger(root, "adapter:napcat");
    logger.info({ event: "napcat.inbound.submitted", messageText: "正文安全样例",
      rootInformationId: "019921ab-cdef-7000-8000-000000000001", token: "secret-value", prompt: "private-prompt" }, "Adapter inbound message");
    logger.error({ event: "operation.failed", err: Object.assign(new Error("unsafe-error-message"), { code: "TEST_FAILURE" }),
      req: { method: "GET", url: "/healthz?token=secret-value", headers: { authorization: "hidden-headers" } } });
    await closeLogger(root);
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    },
  );
}
