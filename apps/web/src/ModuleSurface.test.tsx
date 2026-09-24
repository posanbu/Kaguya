/**
 * 功能概述：验证声明式模块 Surface 能把人物摘要、目录、详情关系与追溯动作渲染为可读界面。
 * 主要职责：使用已校验 DTO 替代网络请求，覆盖 Surface 分流后的主要内容和空关系说明。
 * 代码库关系：ModulePages 的回退行为仍由 ModulePages.test 覆盖；本文件聚焦 ModuleSurface 组件协议。
 * 输入输出与副作用：只做静态 React 渲染，无网络、数据库、剪贴板或人物写入。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { InspectionModule } from "@kaguya/schema";

vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path: string | undefined) =>
    path?.includes("/entities/")
      ? {
          data: {
            version: 1,
            surfaceId: "people",
            entity: {
              entityId: "person-1",
              entityKey: "10001",
              title: "Ada · 研究组",
              subtitle: "qq · 10001",
              platform: "qq",
              status: "complete",
              occurredAt: "2026-09-18T01:00:00Z",
              fields: [{ label: "账号", value: "10001" }],
            },
            sections: [
              {
                id: "observations",
                title: "名称观察时间线",
                presentation: "timeline",
                items: [
                  {
                    id: "observation-1",
                    occurredAt: "2026-09-18T01:00:00Z",
                    fields: [{ label: "群名片", value: "Ada · 研究组" }],
                    sourceInformationId: "observation-1",
                  },
                ],
              },
              {
                id: "scopes",
                title: "关联会话范围",
                presentation: "relationship-graph",
                items: [],
              },
            ],
          },
        }
      : {
          data: {
            version: 1,
            surfaceId: "people",
            summary: {
              windowStartedAt: "2026-09-17T01:00:00Z",
              windowHours: 24,
              counts: [
                { status: "complete", count: 3 },
                { status: "unresolved", count: 1 },
              ],
            },
            items: [
              {
                entityId: "person-1",
                entityKey: "10001",
                title: "Ada · 研究组",
                subtitle: "qq · 10001",
                platform: "qq",
                status: "complete",
                occurredAt: "2026-09-18T01:00:00Z",
                fields: [{ label: "账号", value: "10001" }],
              },
            ],
            platforms: ["qq"],
            statuses: ["complete", "unresolved"],
            nextCursor: null,
          },
        },
}));

import { ModuleSurface } from "./ModuleSurface.js";

const module = {
  definitionId: "memory.identity",
  displayName: "身份归一",
  summary: "将账号解析为人物。",
  description: "只读身份检查。",
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
    mechanism: ["关联账号与人物实体。"],
    views: [],
    surface: {
      version: 1,
      id: "people",
      title: "人物与身份",
      layout: { type: "master-detail", areas: ["summary", "main"] },
      components: [
        {
          id: "summary",
          type: "status-summary",
          area: "summary",
          viewId: "history",
          kinds: ["memory.identity.person.context.completed"],
          statusField: "status",
          windowHours: 24,
        },
        {
          id: "browser",
          type: "entity-browser",
          area: "main",
          viewId: "identities",
          entityKind: "memory.identity.person.entity",
          entityKeyField: "accountId",
          activity: {
            viewId: "identities",
            kinds: ["memory.identity.person.observed"],
            entityKeyField: "accountId",
          },
          titleFields: [{ path: "nickname", label: "昵称" }],
          searchFields: [],
          platform: {
            viewId: "identities",
            kind: "memory.identity.platform.account.entity",
            field: "platform",
            entityKeyField: "accountId",
          },
          status: {
            viewId: "history",
            kinds: ["memory.identity.person.context.completed"],
            entityField: "personInformationId",
            statusField: "status",
          },
          relations: [],
        },
      ],
    },
  },
} as unknown as InspectionModule;

it("renders identity status, person-first navigation and semantic detail sections", () => {
  const html = renderToStaticMarkup(
    <ModuleSurface
      module={module}
      token="secret"
      revision={0}
      DetailComponent={() => <p>原始详情</p>}
    />,
  );
  expect(html).toContain("最近 24 小时识别状态");
  expect(html).toContain("人物目录");
  expect(html).toContain("Ada · 研究组");
  expect(html).toContain("名称观察时间线");
  expect(html).toContain("查看原始 Atom");
  expect(html).toContain("尚未记录相关资料");
  expect(html).not.toContain("secret");
});
