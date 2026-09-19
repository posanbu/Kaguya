/**
 * 功能概述：验证真实事件字段在终端中的输入、输出与记忆面板契约。
 * 主要职责：覆盖 Planner 输入/决策、记忆查询/正文/空结果、表达习惯与错误；
 * 确保普通生命周期保持短行、没有记录的模型返回或召回正文不会被凭空补出。
 * 代码库关系：串联 pretty.ts、pretty-events.ts 与 pretty-panel.ts，并通过 prettyFactory
 * 检查运行中终端列数变化，以及窄屏框内完整字段的优先折行；正文来源投影的安全边界
 * 另由 modules 的同步测试负责。
 * 输入输出与副作用：只格式化内存中的日志投影，不连接模型或数据库，不开启额外日志级别。
 */
import { stripVTControlCharacters } from "node:util";

import { prettyFactory } from "pino-pretty";
import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import { createPrettyOptions, formatPrettyMessage } from "./pretty.js";

describe("module input/output panels", () => {
  it("separates Planner Prompt, provenance and the actual decision output", () => {
    const prompt = formatPrettyMessage({
      event: "model.task.prompt",
      taskId: "agent.turn.plan",
      detail: true,
      promptFull: "请决定下一步。\n用户提到：一起看月亮 🌙",
      promptVariables: [
        {
          variableName: "history",
          informationIds: ["history-1"],
          contentDigest: "sha256:demo",
        },
      ],
    });
    expect(prompt).toContain("╭─ Planner · 输入 Prompt");
    expect(prompt).toContain("├─ Prompt");
    expect(prompt).toContain("├─ Provenance");
    expect(prompt).toContain("用户提到：一起看月亮 🌙");
    expect(prompt.match(/请决定下一步/gu)).toHaveLength(1);
    const decision = formatPrettyMessage({
      event: "turn.plan",
      action: "message",
      reason: "用户正在邀请我，应当回应。",
    });
    expect(decision).toContain("╭─ Planner · 决策输出");
    expect(decision).toContain("动作=message");
    expect(decision).toContain("├─ 原因说明");
    expect(decision).toContain("用户正在邀请我，应当回应。");
    expect(decision).not.toContain("Prompt");
  });

  it("displays memory input, registered text and empty retrieval using only available fields", () => {
    const query = formatPrettyMessage({
      event: "association.query",
      method: "sparse-2gram",
      route: "message",
      queryLength: 8,
      limit: 8,
      contentPreview: "以前看月亮的约定",
      contentTruncated: false,
    });
    expect(query).toContain("╭─ 记忆联想 · 检索输入");
    expect(query).toContain("├─ 查询文本预览");
    expect(query).toContain("以前看月亮的约定");
    const memory = formatPrettyMessage({
      event: "memory.text.registered",
      contentPreview: "用户喜欢天文观测。",
      contentTruncated: false,
    });
    expect(memory).toContain("╭─ 记忆 · 正文登记");
    expect(memory).toContain("├─ 记忆正文预览");
    expect(memory).toContain("用户喜欢天文观测。");
    const empty = formatPrettyMessage({
      event: "association.completed",
      status: "empty",
      candidateCount: 0,
      reasonCodes: ["no-sparse-match"],
    });
    expect(empty).toContain("╭─ 记忆联想 · 检索结果");
    expect(empty).toContain("状态=无结果");
    expect(empty).toContain("候选数量=0");
    expect(empty).not.toContain("正文");
    const candidate = formatPrettyMessage({
      event: "association.candidate",
      rank: 0,
      strategy: "sparse-2gram",
      reasonCodes: ["coverage-ranked"],
    });
    expect(candidate).toContain("╭─ 记忆联想 · 召回候选");
    expect(candidate).not.toContain("正文");
  });

  it("frames actual expression summaries and keeps missing content out of info logs", () => {
    const output = formatPrettyMessage({
      event: "expression.selected",
      count: 1,
      reason: "自然匹配",
      habitSummaries: ["分享喜悦 → 简短感叹"],
    });
    expect(output).toContain("╭─ 表达选择 · 输出");
    expect(output).toContain("├─ 表达习惯");
    expect(output).toContain("分享喜悦 → 简短感叹");
    expect(
      formatPrettyMessage({ event: "person.fact.extracted" }),
    ).not.toContain("╭");
    expect(
      formatPrettyMessage({
        event: "person.fact.extracted",
        detail: true,
        contentPreview: "喜欢天文",
      }),
    ).toContain("├─ 事实正文预览");
  });

  it("keeps routine status lines compact and does not invent generic model output", () => {
    for (const log of [
      { event: "server.started" },
      { event: "napcat.connection.connected" },
      {
        event: "model.task.lifecycle",
        status: "completed",
        taskId: "custom.task",
        durationMs: 24,
      },
      { event: "plugin.custom", contentPreview: "custom value" },
    ]) {
      expect(formatPrettyMessage(log)).not.toContain("╭");
    }
    const error = formatPrettyMessage(
      {
        event: "model.task.lifecycle",
        status: "failed",
        taskId: "agent.turn.plan",
        failureStage: "structured-output-parse",
        attemptCount: 2,
      },
      true,
    );
    expect(error).toContain("\u001b[31m╭─ Planner · 执行失败");
    expect(error).toContain("尝试次数=2");
  });

  it("passes current terminal width to frames without truncating Unicode text", () => {
    let columns = 40;
    const pretty = prettyFactory(createPrettyOptions(true, () => columns));
    const record = {
      level: "info",
      event: "message.assistant",
      contentPreview: "月亮🌙与家人👨‍👩‍👧‍👦一起看星星，e\u0301 是一个组合字符。",
    };
    for (const width of [40, 80]) {
      columns = width;
      const output = stripVTControlCharacters(pretty(record)!);
      const frameLines = output
        .split("\n")
        .filter((line) => /^  [╭│├╰]/u.test(line));
      expect(frameLines[0]).toContain("╭─ 回复生成 · 输出");
      expect(frameLines.at(-1)).toMatch(/╰─+╯$/u);
      expect(frameLines.every((line) => stringWidth(line) === width)).toBe(
        true,
      );
      expect(output).toContain("👨‍👩‍👧‍👦");
      expect(output).toContain("e\u0301");
    }
  });

  it.each([40, 60, 100])(
    "keeps fields that fit intact at %i terminal columns",
    (columns) => {
      const output = formatPrettyMessage(
        {
          event: "association.query",
          marker: "x".repeat(columns - 26),
          queryLength: 20,
          route: "👩🏽‍💻中文",
          selection: {
            marker: "x".repeat(columns - 28),
            queryLength: 20,
          },
        },
        false,
        columns,
      );
      const frameLines = output
        .split("\n")
        .filter((line) => /^  [╭│├╰]/u.test(line));
      expect(frameLines.every((line) => stringWidth(line) === columns)).toBe(
        true,
      );
      expect(output.match(/查询字符数=20/gu)).toHaveLength(2);
      expect(output).toContain("检索入口=👩🏽‍💻中文");
    },
  );
});
