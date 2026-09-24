/**
 * 功能概述：验证原始记忆持久库以单行表格呈现，并把结构化会话压缩成可读单元格。
 * 主要职责：覆盖声明列顺序、正文呈现、中文会话类型和纯浏览行为。
 * 代码库关系：使用 ModuleSurface 的生产分派与已校验 storage DTO，不访问真实服务端。
 * 输入输出与副作用：仅静态渲染测试，无网络、数据库或记忆写入。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { InspectionModule } from "@kaguya/schema";

vi.mock("./use-inspection.js", () => ({
  useInspection: () => ({
    data: {
      version: 1,
      available: true,
      title: "原始记忆文档库",
      description: "不应显示的存储说明",
      items: [
        {
          id: "memory-1",
          sourceInformationId: "source-1",
          fields: [
            { label: "正文", value: "今晚去哪里？" },
            { label: "平台", value: "qq" },
            { label: "适配器", value: "napcat.qq.main" },
            {
              label: "会话",
              value: { kind: "group", groupId: "210794534" },
            },
            { label: "账号", value: "1508612775" },
            { label: "发生时间", value: "2026-09-24T10:00:51.000Z" },
          ],
        },
      ],
      nextCursor: null,
    },
  }),
}));

import { ModuleSurface } from "./ModuleSurface.js";
import { compactStorageValue } from "./StorageSurface.js";

const module = {
  definitionId: "memory.writeback",
  tags: ["memory"],
  displayName: "原始记忆",
  summary: "保存入站原文。",
  description: "保存原始记忆。",
  moduleVersion: "1.0.0",
  protocolVersion: 1,
  settingsSchemaFingerprint: "test",
  consumes: [],
  produces: [],
  selectors: [],
  promptRenderers: [],
  diagnostics: [],
  requires: [],
  provides: [],
  bindings: [],
  inspection: {
    storage: "memory",
    mechanism: [],
    views: [],
    surface: {
      version: 1,
      id: "raw-memory",
      title: "原始记忆",
      layout: { type: "sections", areas: ["documents"] },
      components: [
        {
          id: "documents",
          type: "storage-browser",
          area: "documents",
          columns: ["平台", "适配器", "会话", "账号", "发生时间", "正文"],
          empty: "还没有原始记忆。",
        },
      ],
    },
  },
} as InspectionModule;

it("renders each memory as one compact table row without storage prose", () => {
  const html = renderToStaticMarkup(
    <ModuleSurface
      module={module}
      token="secret"
      revision={0}
      DetailComponent={() => <p>不应挂载的来源详情</p>}
    />,
  );
  expect(html).toContain('role="table"');
  expect(html).toContain("今晚去哪里？");
  expect(html).toContain("群聊 · 210794534");
  expect(html.indexOf("发生时间")).toBeLessThan(html.indexOf("正文"));
  expect(html).not.toContain("不应显示的存储说明");
  expect(html).not.toContain("不应挂载的来源详情");
  expect(html).not.toContain("查看来源消息");
  expect(html).not.toContain("aria-pressed");
  expect(html).not.toContain("secret");
});

it("compacts nested storage values without falling back to raw JSON", () => {
  expect(compactStorageValue({ kind: "private", userId: "42" })).toBe(
    "私聊 · 42",
  );
  expect(compactStorageValue(null)).toBe("—");
  expect(compactStorageValue("")).toBe("—");
  expect(compactStorageValue(true)).toBe("是");
});
