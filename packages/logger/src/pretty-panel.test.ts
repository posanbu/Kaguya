/**
 * 功能概述：验证通用日志框在不同终端宽度下的可读性及外部文本处理边界。
 * 主要职责：同步断言圆角边框与分区标题、中文和复杂 emoji 的完整换行、控制字符转义、
 * 空值显示以及彩色输出的正文与无色版本一致，覆盖实际显示列宽而非 UTF-16 字符数。
 * 代码库关系：直接调用 pretty-panel.ts 的 renderPrettyPanel，并用 string-width 及
 * Node 的 ANSI 剥离器检查最终终端文本；业务事件到分区的映射由 pretty.test.ts 覆盖。
 * 输入输出与副作用：仅使用内存文本，不启动进程、服务或计时器，不读写业务状态。
 */
import { stripVTControlCharacters } from "node:util";

import stringWidth from "string-width";
import { describe, expect, it } from "vitest";

import { renderPrettyPanel } from "./pretty-panel.js";

const bodyLines = (output: string): string[] =>
  output
    .split("\n")
    .filter((line) => line.startsWith("  │ "))
    .map((line) => line.slice(4, -2).trimEnd());

describe("terminal panels", () => {
  it.each([
    [40, 40],
    [80, 80],
    [120, 100],
  ])("aligns every border at %i terminal columns", (columns, expectedWidth) => {
    const original = "输入 English 中文 👩🏽‍💻 e\u0301 🇨🇳 🏳️‍🌈".repeat(12);
    const output = renderPrettyPanel({
      title: "联想记忆",
      sections: [{ title: "输入", lines: [original] }],
      columns,
    });
    expect(
      new Set(output.split("\n").map((line) => stringWidth(line))),
    ).toEqual(new Set([expectedWidth]));
    expect(output).toMatch(/^  ╭─ 联想记忆 /u);
    expect(output).toContain("  ├─ 输入 ");
    expect(output.split("\n").at(-1)).toMatch(/^  ╰─+╯$/u);
    // 拼接原始行（保留内部空格）验证未切开 grapheme；排除刚好落在行末的空格干扰。
    expect(bodyLines(output).join("").replaceAll(" ", "")).toBe(
      original.replaceAll(" ", ""),
    );
    for (const line of bodyLines(output)) {
      expect(line).not.toMatch(/^[\u0301\u200d\ufe0f\p{Emoji_Modifier}]/u);
      expect(line).not.toMatch(/\u200d$/u);
    }
  });

  it("keeps explicit line breaks, blank fields and user indentation", () => {
    const output = renderPrettyPanel({
      title: "模型输入输出",
      sections: [
        {
          title: "输入",
          lines: ["  role=system\ncontent=你好\n", "empty=", ""],
        },
        { title: "输出", lines: ["第二段"] },
      ],
      columns: 40,
    });
    expect(bodyLines(output)).toEqual([
      "  role=system",
      "content=你好",
      "",
      "empty=",
      "",
      "第二段",
    ]);
    expect(output).toContain("  ├─ 输出 ");
  });

  it("wraps long and multiline panel and section titles without dropping content", () => {
    const title = "模型调用与记忆信息👩🏽‍💻".repeat(8);
    const output = renderPrettyPanel({
      title: `${title}\n第二行框标题`,
      sections: [{ title: `${title}\n第二行分区标题`, lines: ["正文"] }],
      columns: 40,
    });
    const headingText = output
      .split("\n")
      .map((line) =>
        line.replace(/^  [╭├]─ |^  │ /u, "").replace(/ [─]*[╮┤]$| +│$/u, ""),
      )
      .join("");
    expect(headingText).toContain(`${title}第二行框标题`);
    expect(headingText).toContain(`${title}第二行分区标题`);
    expect(output.split("\n").every((line) => stringWidth(line) === 40)).toBe(
      true,
    );
  });

  it("shows empty sections and an empty panel explicitly", () => {
    expect(bodyLines(renderPrettyPanel({ title: "", sections: [] }))).toEqual([
      "（无内容）",
    ]);
    const output = renderPrettyPanel({
      title: "",
      sections: [{ title: "", lines: [] }],
    });
    expect(output).toContain("╭─ 日志 ");
    expect(output).toContain("├─ 详情 ");
    expect(bodyLines(output)).toEqual(["（空）"]);
  });

  it("only colors controlled frame and heading text", () => {
    const options = {
      title: "记忆",
      sections: [{ title: "召回结果", lines: ["正文 ╭─ │ ╰─╯ 保持原色"] }],
      columns: 40,
    };
    const plain = renderPrettyPanel(options);
    const colored = renderPrettyPanel({
      ...options,
      colorize: true,
      color: 35,
    });
    expect(plain).not.toContain("\u001b");
    expect(colored).toContain("\u001b[35m");
    expect(stripVTControlCharacters(colored)).toBe(plain);
    const content = colored.split("\n").find((line) => line.includes("正文"));
    expect(content).toContain("\u001b[39m 正文 ╭─ │ ╰─╯ 保持原色");
    expect(content?.match(/\u001b\[35m/gu)).toHaveLength(2);
  });

  it("renders ANSI, carriage returns and other controls visibly in all input fields", () => {
    const unsafe = "\u001b[31mred\u001b[0m\r\t\u0007\u0085\u202e";
    const output = renderPrettyPanel({
      title: unsafe,
      sections: [
        { title: unsafe, lines: [unsafe, "│ fake border\nnext line"] },
      ],
    });
    const escaped = "\\u001b[31mred\\u001b[0m\\r\\t\\u0007\\u0085\\u202e";
    expect(output.split(escaped)).toHaveLength(4);
    expect(output).not.toMatch(
      /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/u,
    );
    expect(bodyLines(output)).toEqual([escaped, "│ fake border", "next line"]);
  });

  it("uses a bounded width and color for malformed optional settings", () => {
    for (const columns of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const output = renderPrettyPanel({
        title: "日志",
        sections: [],
        columns,
      });
      expect(
        output.split("\n").every((line) => stringWidth(line) === 100),
      ).toBe(true);
    }
    const output = renderPrettyPanel({
      title: "窄",
      sections: [{ title: "输入", lines: ["中文"] }],
      columns: -1,
      colorize: true,
      color: 12.3,
    });
    expect(
      stripVTControlCharacters(output)
        .split("\n")
        .every((line) => stringWidth(line) === 10),
    ).toBe(true);
    expect(output).toContain("\u001b[36m");
    const narrowEmpty = renderPrettyPanel({
      title: "",
      sections: [],
      columns: 1,
    });
    expect(
      narrowEmpty.split("\n").every((line) => stringWidth(line) === 10),
    ).toBe(true);
  });
});
