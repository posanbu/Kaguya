/**
 * 功能概述：自动发现一方模块目录，验证实现同目录 README 的完整性，不维护中央模块清单。
 * 主要职责：收集阶段扫描当前目录下带 index.ts 的直接子目录，排序后逐模块生成 Vitest 用例；
 * REQUIRED_SECTIONS 约束 README 必需章节，每个用例同时检查一级标题。
 * 代码库关系：以 first-party 目录中的实现入口为发现依据；运行时注册由 catalog.test.ts 独立验证。
 * 输入输出与副作用：仅执行本地只读文件检查；缺少 index.ts 的 helper-only 目录被忽略，
 * 其他文件访问错误直接抛出，缺失 README 或章节会使对应模块用例失败。
 */
import { access, readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const REQUIRED_SECTIONS = [
  "## 目的与非目标",
  "## 消费和产生",
  "## 数据流与边界",
  "## Settings",
  "## 可靠性、幂等和失败行为",
  "## 日志与可观测性",
  "## 典型场景",
] as const;

const entries = await readdir(new URL(".", import.meta.url), {
  withFileTypes: true,
});
const implemented: string[] = [];
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  try {
    await access(new URL(`./${entry.name}/index.ts`, import.meta.url));
    implemented.push(entry.name);
  } catch (error) {
    // 仅忽略没有实现入口的 helper-only 目录，其他读取异常应暴露为测试错误。
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

describe("first-party module documentation", () => {
  it.each(implemented.sort())(
    "keeps %s documentation beside its implementation",
    async (name) => {
      const markdown = await readFile(
        new URL(`./${name}/README.md`, import.meta.url),
        "utf8",
      );
      expect(markdown).toMatch(/^# \S/mu);
      for (const section of REQUIRED_SECTIONS)
        expect(markdown).toContain(section);
    },
  );
});
