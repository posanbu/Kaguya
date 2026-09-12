/**
 * 功能概述：验证显式一方模块目录及其随附 README 的完整性。
 * 主要职责：MODULES 固定受信模块清单，REQUIRED_SECTIONS 约束说明章节；Vitest 读取模块目录与文档进行核对。
 * 输入输出与副作用：仅执行本地只读文件检查，确保在线模块、speech Planner 及 Memory 后台模块没有遗漏实现或文档。
 */
import { access, readFile, readdir } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const MODULES = [
  "association",
  "attention-arousal",
  "heartbeat",
  "heartflow",
  "identity",
  "memory-writeback",
  "memory-index",
  "memory-cognition",
  "message-composer",
  "person-fact-task",
  "speech",
] as const;
const REQUIRED_SECTIONS = [
  "## 目的与非目标",
  "## 消费和产生",
  "## 数据流与边界",
  "## Settings",
  "## 可靠性、幂等和失败行为",
  "## 日志与可观测性",
  "## 典型场景",
] as const;

describe("first-party module documentation", () => {
  it("tracks every first-party module implementation", async () => {
    const entries = await readdir(new URL(".", import.meta.url), {
      withFileTypes: true,
    });
    const implemented: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await access(new URL(`./${entry.name}/index.ts`, import.meta.url));
        implemented.push(entry.name);
      } catch {
        // Helper-only directories are not module definitions.
      }
    }
    expect(implemented.sort()).toEqual([...MODULES].sort());
  });

  it.each(MODULES)(
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
