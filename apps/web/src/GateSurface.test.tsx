import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
  moduleInspectionSurfaceSchema,
  type InspectionModule,
  type JsonValue,
} from "@kaguya/schema";
import { ModuleSurface } from "./ModuleSurface.js";

const fixture = vi.hoisted(() => ({ page: {} as any, detail: {} as any }));
vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path: string | undefined) =>
    path?.includes("/entities/") ? fixture.detail : fixture.page,
}));

const module = {
  definitionId: "agent.attention.arousal",
  inspection: {
    mechanism: ["不观察就不读取正文。"],
    views: [],
    surface: moduleInspectionSurfaceSchema.parse({
      version: 1,
      id: "arousal",
      title: "注意力观察",
      layout: { type: "master-detail", areas: ["main"] },
      components: [
        {
          id: "gates",
          type: "record-browser",
          presentation: "attention-gate",
          area: "main",
          viewId: "gates",
          recordKind: "agent.attention.arousal.completed",
          titleField: "scopeKey",
          searchFields: ["scopeKey", "signals"],
          fields: [{ path: "outcome", label: "结果" }],
          status: {
            field: "outcome",
            options: [
              { value: "observe", label: "查看未读" },
              { value: "defer", label: "延后观察" },
            ],
          },
          labels: {
            directory: "观察历史",
            search: "会话或触发",
            placeholder: "输入会话或触发",
            empty: "暂无观察记录",
            mechanism: "观察机制",
          },
          relations: [
            {
              id: "candidate",
              title: "观察机会",
              viewId: "gates",
              kinds: ["agent.turn.candidate"],
              reference: "core:status-of",
              presentation: "field-grid",
              fields: [{ path: "unreadCount", label: "未读数量" }],
              empty: "没有观察机会",
              limit: 1,
            },
          ],
        },
      ],
    }),
  },
} as unknown as InspectionModule;

function setRecord(values: Record<string, JsonValue>, withRelation = true) {
  const entity = {
    entityId: "observation-1",
    entityKey: "observation-1",
    title: "qq:demo:group:research",
    subtitle: "",
    occurredAt: "2026-09-22T08:42:00Z",
    fields: Object.entries(values).map(([path, value]) => ({
      path,
      label: path,
      value,
    })),
  };
  fixture.page = {
    data: inspectionRecordPageSchema.parse({
      version: 1,
      surfaceId: "arousal",
      items: [entity],
      nextCursor: null,
    }),
  };
  fixture.detail = {
    data: inspectionSurfaceEntitySchema.parse({
      version: 1,
      surfaceId: "arousal",
      entity,
      sections: [
        {
          id: "candidate",
          title: "观察机会",
          presentation: "field-grid",
          items: withRelation
            ? [
                {
                  id: "candidate-1",
                  occurredAt: entity.occurredAt,
                  fields: [
                    { path: "unreadCount", label: "未读数量", value: 4 },
                  ],
                },
              ]
            : [],
        },
      ],
    }),
  };
}

const render = () =>
  renderToStaticMarkup(
    <ModuleSurface
      module={module}
      token="redacted-token"
      revision={0}
      DetailComponent={() => <p>关系详情</p>}
    />,
  );

beforeEach(() => {
  setRecord({
    outcome: "observe",
    arousalState: "awake",
    arousalStateInformationId: "state-1",
    wakeSignal: true,
    scopeKey: "qq:demo:group:research",
    unreadCount: 4,
    signals: ["mention-self"],
    focusState: "inactive",
    reasonCodes: ["mention-self"],
    unreadAfterInformationId: "lower",
    unreadThroughInformationId: "upper",
    policyVersion: "attention-observation.v1",
  });
});

it("shows observation result, trigger, unread count and relationship tracking", () => {
  const html = render();
  expect(html).toContain("直接通知触发查看");
  expect(html).toContain("未读 4 条");
  expect(html).toContain("唤醒态");
  expect(html).toContain("已触发");
  expect(html).toContain("@ 自己");
  expect(html).toContain("追踪关系");
  expect(html).toContain("本视图不查询或展示消息正文");
  expect(html).not.toContain("redacted-token");
  expect(html).not.toContain("评分");
});

it("makes defer and missing Focus explicit", () => {
  setRecord(
    {
      outcome: "defer",
      arousalState: "asleep",
      arousalStateInformationId: "state-1",
      wakeSignal: false,
      scopeKey: "qq:demo:group:research",
      unreadCount: 2,
      signals: ["passive"],
      focusState: "unavailable",
      reasonCodes: ["arousal-asleep"],
      unreadThroughInformationId: "upper",
      policyVersion: "attention-observation.v1",
    },
    false,
  );
  const html = render();
  expect(html).toContain("休眠态暂不查看，等待唤醒");
  expect(html).toContain("本次没有读取或冻结正文");
  expect(html).toContain("Focus 状态缺失");
  expect(html).toContain("没有已记录的关联事实");
});

it("keeps the reused pager and bounded-list context", () => {
  fixture.page.data.nextCursor = "next-page";
  const html = render();
  expect(html).toContain("本页 1 条");
  expect(html).toContain("非全库统计");
  expect(html).toContain("第 1 页");
  expect(html).toContain("下一页");
});

it("distinguishes empty, loading and failed observation lists", () => {
  fixture.page = {
    data: inspectionRecordPageSchema.parse({
      version: 1,
      surfaceId: "arousal",
      items: [],
      nextCursor: null,
    }),
  };
  expect(render()).toContain("尚无注意力观察记录");
  fixture.page = {};
  expect(render()).toContain("正在加载观察记录");
  fixture.page = { error: "HTTP 503" };
  const failed = render();
  expect(failed).toContain("观察记录读取失败：HTTP 503");
  expect(failed).toContain("重新读取");
  expect(failed).not.toContain("直接通知触发查看");
});
