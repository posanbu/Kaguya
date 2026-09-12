/**
 * 功能概述：负责第一方消息编写和人物事实模板的 Node 文件加载与验证（或其回归测试）。
 * 主要职责：loadFirstPartyPromptTemplates 返回 messageComposer/personFact；优先 local 覆盖并保留空白，
 * 缺失 local 才回退 default，空模板、读取错误和模板编译错误直接失败。
 * 代码库关系：message-prompt 提供编译校验，templates/message-composer.* 提供各层布局；Runtime 消费结果。
 * 输入输出与副作用：只读模板文件；测试使用临时目录验证覆盖策略并在结束后清理。
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadFirstPartyPromptTemplates } from "./prompt-templates.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function root(): { path: string; url: URL } {
  const path = mkdtempSync(join(tmpdir(), "kaguya-prompts-"));
  roots.push(path);
  return { path, url: pathToFileURL(`${path}/`) };
}

describe("loadFirstPartyPromptTemplates", () => {
  it("prefers local files and preserves whitespace", () => {
    const directory = root();
    writeDefaults(directory.path);
    writeFileSync(
      join(directory.path, "message-composer.local.hbs"),
      "  local\n",
    );

    const loaded = loadFirstPartyPromptTemplates({ root: directory.url });
    expect(loaded.messageComposer.main).toBe("  local\n");
    expect(loaded.messageComposer.history).toBe("message-composer.history");
    expect(loaded.personFact).toBe("person-fact");
  });

  it("rejects an empty selected template", () => {
    const directory = root();
    writeDefaults(directory.path);
    writeFileSync(join(directory.path, "message-composer.local.hbs"), "");
    expect(() =>
      loadFirstPartyPromptTemplates({ root: directory.url }),
    ).toThrow("Prompt template is empty: message-composer");
  });

  it("does not hide a local-template read failure behind the default", () => {
    const directory = root();
    writeDefaults(directory.path);
    mkdirSync(join(directory.path, "message-composer.local.hbs"));
    expect(() =>
      loadFirstPartyPromptTemplates({ root: directory.url }),
    ).toThrow();
  });

  it("keeps every local Handlebars override out of Git", () => {
    expect(readFileSync(join(process.cwd(), ".gitignore"), "utf8")).toContain(
      "packages/modules/templates/*.local.hbs",
    );
  });

  it("keeps tracked default templates on LF across Git checkouts", () => {
    expect(
      readFileSync(join(process.cwd(), ".gitattributes"), "utf8"),
    ).toContain("packages/modules/templates/*.default.hbs text eol=lf");
  });
});

const templateNames = [
  "message-composer",
  "message-composer.history",
  "message-composer.history-inbound",
  "message-composer.history-assistant",
  "message-composer.memory",
  "message-composer.memory-item",
  "message-composer.quoted",
  "message-composer.turn",
  "person-fact",
] as const;

function writeDefaults(path: string): void {
  for (const name of templateNames)
    writeFileSync(join(path, `${name}.default.hbs`), name);
}
