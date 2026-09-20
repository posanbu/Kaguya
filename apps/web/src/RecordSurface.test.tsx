/**
 * 功能概述：验证记录 Surface 的语义状态和候选追溯入口，避免人物文案、空查询误报加载与来源缺失静默丢失。
 * 主要职责：以已校验 DTO 模拟 useInspection 的页面/详情状态，SSR 检查正文与操作；交互和响应式另由浏览器验证。
 * 代码库关系：测试生产 ModuleSurface 分派到 RecordSurface；不访问网络、不运行数据库或轮询。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { InspectionModule } from "@kaguya/schema";
import { ModuleSurface } from "./ModuleSurface.js";
const fixture = vi.hoisted(() => ({
  page: {} as Record<string, unknown>,
  detail: {} as Record<string, unknown>,
}));
vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path: string) =>
    path?.includes("/entities/") ? fixture.detail : fixture.page,
}));
const module = {
  definitionId: "core.association.memory",
  inspection: {
    mechanism: ["范围内检索"],
    views: [],
    surface: {
      version: 1,
      id: "associations",
      title: "记忆联想",
      layout: { type: "master-detail", areas: ["main"] },
      components: [
        {
          id: "queries",
          type: "record-browser",
          area: "main",
          viewId: "queries",
          recordKind: "agent.association.query",
          titleField: "query",
          searchFields: ["query"],
          fields: [],
          labels: {
            directory: "联想记录",
            search: "查找联想",
            placeholder: "查询内容",
            empty: "尚无联想查询。",
            mechanism: "联想机制",
          },
          notice: "召回不代表进入 Prompt。",
          relations: [
            {
              id: "result",
              title: "结果",
              viewId: "retrieval",
              kinds: ["agent.association.completed"],
              reference: "core:caused-by",
              presentation: "field-grid",
              fields: [],
              empty: "尚未记录完成结果",
              limit: 1,
            },
            {
              id: "candidates",
              title: "候选",
              viewId: "retrieval",
              kinds: ["agent.association.candidate"],
              reference: "core:caused-by",
              presentation: "ranked-list",
              fields: [],
              empty: "尚无候选",
              limit: 10,
            },
          ],
        },
      ],
    },
  },
} as unknown as InspectionModule;
const item = {
  entityId: "query-1",
  entityKey: "query-1",
  title: "实验方案怎么选",
  subtitle: "",
  occurredAt: "2026-09-19T07:42:00Z",
  fields: [],
};
const render = () =>
  renderToStaticMarkup(
    <ModuleSurface
      module={module}
      token="never-render-token"
      revision={0}
      DetailComponent={() => <p>来源</p>}
    />,
  );
beforeEach(() => {
  fixture.page = {
    data: {
      version: 1,
      surfaceId: "associations",
      items: [item],
      nextCursor: null,
    },
  };
  fixture.detail = {
    data: {
      version: 1,
      surfaceId: "associations",
      entity: item,
      sections: [
        { id: "result", title: "结果", presentation: "field-grid", items: [] },
        {
          id: "candidates",
          title: "记忆候选",
          presentation: "ranked-list",
          items: [
            {
              id: "candidate-1",
              rank: 0,
              occurredAt: item.occurredAt,
              fields: [],
              sourceInformationId: "candidate-1",
              relatedSource: {
                available: true,
                informationId: "source-1",
                fields: [{ label: "原文", value: "保留方案 B" }],
              },
            },
          ],
        },
      ],
    },
  };
});
it("renders record-specific evidence, rank and two distinct trace actions", () => {
  const html = render();
  expect(html).toContain("实验方案怎么选");
  expect(html).toContain("保留方案 B");
  expect(html).toContain("排名 1");
  expect(html).toContain("查看来源");
  expect(html).toContain("候选回执");
  expect(html).toContain("尚未记录完成结果");
  expect(html).not.toContain("人物");
  expect(html).not.toContain("相关度");
  expect(html).not.toContain("never-render-token");
});
it("keeps an empty directory distinct from a loading detail", () => {
  fixture.page = {
    data: {
      version: 1,
      surfaceId: "associations",
      items: [],
      nextCursor: null,
    },
  };
  const html = render();
  expect(html).toContain("尚无联想记录");
  expect(html).not.toContain("正在加载查询详情");
});
it("keeps loading and failed reads distinct and offers refresh", () => {
  fixture.page = {};
  expect(render()).toContain("正在加载联想记录");
  fixture.page = { error: "HTTP 503" };
  const html = render();
  expect(html).toContain("记录读取失败");
  expect(html).toContain("刷新联想记录");
  expect(html).not.toContain("实验方案怎么选");
});
it("retains the receipt when a source is unavailable and discloses truncation", () => {
  const detail = fixture.detail.data as {
    sections: { truncated?: boolean; items: { relatedSource?: unknown }[] }[];
  };
  detail.sections[1]!.items[0]!.relatedSource = {
    available: false,
    fields: [],
  };
  detail.sections[1]!.truncated = true;
  const html = render();
  expect(html).toContain("来源记录不可用");
  expect(html).toContain("候选回执");
  expect(html).not.toContain("查看来源");
  expect(html).toContain("已截断");
});
