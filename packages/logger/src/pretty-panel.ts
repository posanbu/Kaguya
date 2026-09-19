/**
 * 功能概述：为终端日志提供有明确标题和分区的圆角文本框，只负责显示，不解释业务事件。
 * 主要职责：renderPrettyPanel 接收框标题、PrettyPanelSection 分区及终端列数，返回两格
 * 缩进的完整框；getPrettyPanelContentWidth 供调用方使用同一正文列宽优先按字段折行；
 * escapeControls 将外部控制字符转成可见文本，wrapLines 按 Unicode
 * grapheme 换行，保留中文、组合字符和 emoji，避免右边框因 UTF-16 长度计算而错位。
 * 代码库关系：供 pretty.ts 的模块输入、输出、记忆等展示使用；依赖 string-width 计算
 * 实际显示列宽，pretty-panel.test.ts 验证宽度、颜色和外部内容的终端安全边界。
 * 输入输出与副作用：纯字符串渲染，不修改记录、不写流、不读取环境；columns 包含外侧
 * 两格缩进，默认最多 100 列，极窄终端至少保留 10 列。只为边框和标题添加受控 ANSI，
 * 正文颜色保持终端默认值；输入换行保留，其余终端控制字符可见转义，空分区明确标识。
 */
import stringWidth from "string-width";

export interface PrettyPanelSection {
  title: string;
  lines: readonly string[];
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DEFAULT_COLUMNS = 100;
const MIN_COLUMNS = 10;

export function getPrettyPanelContentWidth(columns?: number): number {
  const requestedColumns = columns ?? DEFAULT_COLUMNS;
  const frameColumns = Number.isFinite(requestedColumns)
    ? Math.max(
        MIN_COLUMNS,
        Math.min(DEFAULT_COLUMNS, Math.floor(requestedColumns)),
      )
    : DEFAULT_COLUMNS;
  // 外侧缩进两列、左右边框两列、正文内边距两列。
  return frameColumns - 6;
}

function escapeControls(text: string): string {
  return text.replace(
    /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/gu,
    (character) => {
      if (character === "\r") return "\\r";
      if (character === "\t") return "\\t";
      return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    },
  );
}

function wrapLines(text: string, width: number): string[] {
  return escapeControls(text)
    .split("\n")
    .flatMap((line) => {
      const wrapped: string[] = [];
      let current = "";
      let currentWidth = 0;
      for (const { segment } of segmenter.segment(line)) {
        const segmentWidth = stringWidth(segment);
        if (currentWidth + segmentWidth > width && current !== "") {
          wrapped.push(current);
          current = "";
          currentWidth = 0;
        }
        current += segment;
        currentWidth += segmentWidth;
      }
      wrapped.push(current);
      return wrapped;
    });
}

export function renderPrettyPanel(options: {
  title: string;
  sections: readonly PrettyPanelSection[];
  columns?: number;
  colorize?: boolean;
  color?: number;
}): string {
  const contentWidth = getPrettyPanelContentWidth(options.columns);
  const innerWidth = contentWidth + 2;
  const headingWidth = innerWidth - 3;
  const requestedColor = options.color ?? 36;
  const color =
    Number.isInteger(requestedColor) &&
    ((requestedColor >= 30 && requestedColor <= 37) ||
      (requestedColor >= 90 && requestedColor <= 97))
      ? requestedColor
      : 36;
  const paint = (value: string): string =>
    options.colorize ? `\u001b[${color}m${value}\u001b[39m` : value;
  const row = (value: string, isHeading = false): string =>
    `  ${paint("│")} ${isHeading ? paint(value) : value}${" ".repeat(contentWidth - stringWidth(value))} ${paint("│")}`;
  const heading = (value: string, top: boolean): string[] => {
    const [first = "", ...continuations] = wrapLines(value, headingWidth);
    const left = top ? "╭" : "├";
    const right = top ? "╮" : "┤";
    return [
      `  ${paint(`${left}─ ${first} ${"─".repeat(headingWidth - stringWidth(first))}${right}`)}`,
      ...continuations.map((line) => row(line, true)),
    ];
  };

  const output = heading(options.title || "日志", true);
  for (const section of options.sections) {
    output.push(...heading(section.title || "详情", false));
    const lines = section.lines.length > 0 ? section.lines : ["（空）"];
    for (const line of lines) {
      output.push(...wrapLines(line, contentWidth).map((part) => row(part)));
    }
  }
  if (options.sections.length === 0) {
    output.push(
      ...wrapLines("（无内容）", contentWidth).map((part) => row(part)),
    );
  }
  output.push(`  ${paint(`╰${"─".repeat(innerWidth)}╯`)}`);
  return output.join("\n");
}
