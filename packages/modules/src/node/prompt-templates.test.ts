/**
 * 功能概述：负责第一方消息编写和人物事实模板的 Node 文件加载与验证（或其回归测试）。
 * 主要职责：遍历全模块声明验证 default/local 文件完备性、覆盖优先级和安全初始化；优先 local 并保留空白，
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
  readdirSync,
  existsSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadFirstPartyPromptTemplates,
  initializeLocalPromptTemplates,
  readPromptResources,
} from "./prompt-templates.js";
import { firstPartyPromptTemplateGroups } from "../prompt-declarations.js";
import { execFileSync } from "node:child_process";

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

const templateNames = firstPartyPromptTemplateGroups.flatMap((group) =>
  group.map((d) => d.templateId),
);

function writeDefaults(path: string): void {
  for (const name of templateNames)
    writeFileSync(join(path, `${name}.default.hbs`), name);
}

it("loads every declared module template from files and never creates local files while reading", () => {
  const directory = root();
  writeDefaults(directory.path);
  const loaded = loadFirstPartyPromptTemplates({ root: directory.url });
  expect(loaded.planner).toBe("heartflow.planner");
  expect(loaded.plannerBootstrapPolicy).toBe("heartflow.bootstrap-policy");
  expect(loaded.messageComposer.bootstrap).toBe("message-composer.bootstrap");
  expect(loaded.expression).toEqual({
    learn: "expression.learn",
    select: "expression.select",
  });
  expect(loaded.authorizedMessage).toEqual({
    automatic: "message-composer.authorized-automatic",
    admin: "message-composer.authorized-admin",
  });
  expect(
    readdirSync(directory.path).every((name) => name.endsWith(".default.hbs")),
  ).toBe(true);
});

it.each(templateNames)(
  "prefers the local copy for %s and rejects a missing default",
  (id) => {
    const directory = root();
    writeDefaults(directory.path);
    const group = firstPartyPromptTemplateGroups.find((items) =>
      items.some((d) => d.templateId === id),
    )!;
    writeFileSync(join(directory.path, `${id}.local.hbs`), `LOCAL ${id}`);
    expect(
      readPromptResources(group, directory.url).find(
        (v) => v.templateId === id,
      ),
    ).toMatchObject({
      content: `LOCAL ${id}`,
      defaultContent: id,
      source: "local",
    });
    rmSync(join(directory.path, `${id}.default.hbs`));
    expect(() => readPromptResources(group, directory.url)).toThrow(
      "Missing default Prompt template",
    );
  },
);

it("initializes missing local copies without replacing existing content or changing defaults", () => {
  const directory = root();
  writeDefaults(directory.path);
  writeFileSync(
    join(directory.path, "heartflow.planner.local.hbs"),
    "MY PLANNER",
  );
  const result = initializeLocalPromptTemplates(directory.url);
  expect(result.created).toHaveLength(templateNames.length - 1);
  expect(result.preserved).toEqual(["heartflow.planner"]);
  for (const id of templateNames) {
    expect(
      readFileSync(join(directory.path, `${id}.default.hbs`), "utf8"),
    ).toBe(id);
    expect(readFileSync(join(directory.path, `${id}.local.hbs`), "utf8")).toBe(
      id === "heartflow.planner" ? "MY PLANNER" : id,
    );
  }
  expect(initializeLocalPromptTemplates(directory.url).created).toEqual([]);
});

it("provides a default file for every declaration and Git ignores only its local counterpart", () => {
  const relativeRoot = "packages/modules/templates/";
  const defaults = templateNames.map(
    (id) => `${relativeRoot}${id}.default.hbs`,
  );
  for (const path of defaults)
    expect(existsSync(join(process.cwd(), path)), path).toBe(true);
  expect(
    readdirSync(join(process.cwd(), relativeRoot))
      .filter((name) => name.endsWith(".default.hbs"))
      .sort(),
  ).toEqual(templateNames.map((id) => `${id}.default.hbs`).sort());
  const locals = templateNames.map((id) => `${relativeRoot}${id}.local.hbs`);
  const ignored = execFileSync(
    "git",
    ["check-ignore", "--no-index", "--stdin"],
    {
      cwd: process.cwd(),
      input: [...defaults, ...locals].join("\n") + "\n",
      encoding: "utf8",
    },
  )
    .trim()
    .split("\n");
  expect(ignored.sort()).toEqual(locals.sort());
});
