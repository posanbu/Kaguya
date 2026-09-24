/**
 * 功能概述：验证 Wiki 页面以目录和正文阅读器呈现，修订历史与证据退居次级。
 * 主要职责：覆盖人物页标题、正文分段、脏页说明、历史折叠和无 Atom 详情行为。
 * 代码库关系：通过 ModuleSurface 的生产分派渲染 wiki-browser。
 * 输入输出与副作用：静态渲染测试，不访问真实服务或数据库。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { InspectionModule } from "@kaguya/schema";

vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path: string) =>
    path.includes("/entities/")
      ? {
          data: {
            version: 1,
            surfaceId: "wiki-memory",
            page: {
              pageId: "page-1",
              scopeInformationId: "scope-1",
              entityInformationId: "person-1",
              title: "月见",
              pageType: "entity",
              version: 3,
              dirty: true,
              reasons: ["evidence_after_cutoff"],
              updatedAt: "2026-09-24T11:00:00.000Z",
              sectionCount: 1,
              excerpt: "今晚喝茶",
            },
            sections: [
              {
                heading: "2026-09-24T10:00:00.000Z · message",
                content: "原始经历（person-1）\n今晚喝茶",
                evidenceSourceInformationIds: ["source-1"],
                claimIds: [],
              },
            ],
            history: [
              {
                version: 3,
                recordedAt: "2026-09-24T11:00:00.000Z",
                sectionCount: 1,
              },
            ],
            historyTruncated: false,
          },
        }
      : {
          data: {
            version: 1,
            surfaceId: "wiki-memory",
            items: [
              {
                pageId: "page-1",
                scopeInformationId: "scope-1",
                entityInformationId: "person-1",
                title: "月见",
                pageType: "entity",
                version: 3,
                dirty: true,
                reasons: ["evidence_after_cutoff"],
                updatedAt: "2026-09-24T11:00:00.000Z",
                sectionCount: 1,
                excerpt: "今晚喝茶",
              },
            ],
            nextCursor: null,
          },
        },
}));

import { ModuleSurface } from "./ModuleSurface.js";

const module = {
  definitionId: "memory.knowledge",
  tags: ["memory"],
  displayName: "Wiki 记忆",
  summary: "持续整理 Wiki 页面。",
  description: "整理 Wiki。",
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
    mechanism: [],
    views: [],
    surface: {
      version: 1,
      id: "wiki-memory",
      title: "Wiki 记忆",
      layout: { type: "master-detail", areas: ["pages"] },
      components: [
        {
          id: "wiki-pages",
          type: "wiki-browser",
          area: "pages",
          viewId: "pages",
          pageKind: "memory.knowledge.wiki.updated",
          empty: "还没有 Wiki 页面。",
        },
      ],
    },
  },
} as InspectionModule;

it("renders a page directory and readable current page", () => {
  const html = renderToStaticMarkup(
    <ModuleSurface
      module={module}
      token="secret"
      revision={0}
      DetailComponent={() => <p>不应加载 Atom 详情</p>}
    />,
  );
  expect(html).toContain('aria-label="Wiki 页面目录"');
  expect(html).toContain("月见");
  expect(html).toContain("今晚喝茶");
  expect(html).toContain("新证据正在等待整理");
  expect(html).toContain("修订历史 · 1");
  expect(html).not.toContain("Wiki 页面修订");
  expect(html).not.toContain("不应加载 Atom 详情");
  expect(html).not.toContain("secret");
});
