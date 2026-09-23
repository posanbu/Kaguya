/**
 * 功能概述：验证 record-browser 与 model-request-browser 的 wire 边界，拒绝表达式式字段路径、无界分组和不合法来源状态。
 * 主要职责：覆盖门控展示、状态选项、正向引用与带 path 的字段；旧声明继续解析，非法 direction 和重复状态拒绝。
 * 同时校验逐次请求目录和 Prompt 可用性；空目录可携带后续扫描游标，完整 Prompt 不限摘要长度。
 * 代码库关系：直接消费 inspection.ts；仅纯 Schema 解析，不做网络或数据库操作。
 */
import { expect, it } from "vitest";
import {
  moduleInspectionSurfaceSchema,
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
  inspectionPresentationSchema,
  inspectionRequestPageSchema,
  inspectionRequestDetailSchema,
} from "./inspection.js";
const component = {
  id: "queries",
  type: "record-browser",
  area: "main",
  viewId: "queries",
  recordKind: "test.query",
  titleField: "query",
  searchFields: ["query"],
  fields: [{ path: "query", label: "查询" }],
  labels: {
    directory: "记录",
    search: "查询",
    placeholder: "内容",
    empty: "暂无",
    mechanism: "机制",
  },
  relations: [
    {
      id: "result",
      title: "结果",
      viewId: "results",
      kinds: ["test.result"],
      reference: "core:caused-by",
      presentation: "ranked-list",
      fields: [{ path: "rank", label: "排名" }],
      rankField: "rank",
      limit: 10,
      empty: "暂无",
    },
  ],
};
const surface = (value: unknown) => ({
  version: 1,
  id: "records",
  title: "记录",
  layout: { type: "master-detail", areas: ["main"] },
  components: [value],
});

it("accepts model requests with bounded-scan continuation and an independent complete prompt", () => {
  const browser = {
    id: "requests",
    type: "model-request-browser",
    area: "main",
    viewId: "model-requests",
    taskId: "agent.turn.plan",
    mode: "planner",
  };
  expect(
    moduleInspectionSurfaceSchema.parse(surface(browser)).components[0]!.type,
  ).toBe("model-request-browser");
  expect(
    inspectionRequestPageSchema.parse({
      version: 1,
      surfaceId: "requests",
      items: [],
      nextCursor: "next-scan-boundary",
    }).nextCursor,
  ).toBe("next-scan-boundary");
  const detail = {
    version: 1,
    surfaceId: "requests",
    request: {
      requestId: "request",
      occurredAt: "2026-09-19T10:00:00.000Z",
      status: "completed",
      triggerText: "入站",
      outcomeText: "静默",
      inputCount: 1,
    },
    inputs: [],
    prompt: { available: true, text: "完整 Prompt".repeat(2000) },
    result: { action: "silent" },
    trace: [],
    truncated: false,
    contextAvailable: false,
  };
  expect(inspectionRequestDetailSchema.parse(detail).prompt.text).toBe(
    detail.prompt.text,
  );
  expect(
    inspectionRequestDetailSchema.parse({
      ...detail,
      prompt: { available: false },
    }).prompt.available,
  ).toBe(false);
  expect(() =>
    inspectionRequestDetailSchema.parse({
      ...detail,
      prompt: { available: true },
    }),
  ).toThrow();
  expect(() =>
    inspectionRequestDetailSchema.parse({
      ...detail,
      prompt: { available: false, text: "hidden" },
    }),
  ).toThrow();
  expect(() =>
    moduleInspectionSurfaceSchema.parse(
      surface({ ...browser, mode: "unknown" }),
    ),
  ).toThrow();
});
it("accepts bounded declarative records without identity-only metadata", () => {
  expect(
    moduleInspectionSurfaceSchema.parse(surface(component)).components[0]!.type,
  ).toBe("record-browser");
  expect(
    inspectionRecordPageSchema.parse({
      version: 1,
      surfaceId: "records",
      items: [],
      nextCursor: null,
    }).items,
  ).toEqual([]);
});
it("rejects executable paths and unbounded relation reads", () => {
  expect(() =>
    moduleInspectionSurfaceSchema.parse(
      surface({ ...component, titleField: "query[0]" }),
    ),
  ).toThrow();
  expect(() =>
    moduleInspectionSurfaceSchema.parse(
      surface({
        ...component,
        relations: [{ ...component.relations[0], limit: 501 }],
      }),
    ),
  ).toThrow();
  expect(() =>
    inspectionSurfaceEntitySchema.parse({
      version: 1,
      surfaceId: "records",
      entity: {},
      sections: [],
    }),
  ).toThrow();
});
it("preserves observation declarations and stable field paths while rejecting invalid state contracts", () => {
  const gate = {
    ...component,
    presentation: "attention-gate",
    status: {
      field: "outcome",
      options: [{ value: "observe", label: "查看未读" }],
    },
    relations: [{ ...component.relations[0], direction: "forward" }],
  };
  expect(
    moduleInspectionSurfaceSchema.parse(surface(gate)).components[0],
  ).toMatchObject(gate);
  expect(
    inspectionPresentationSchema.parse({
      title: "门控",
      fields: [
        { path: "unreadCount", label: "未读数量", value: 42 },
        { label: "兼容字段", value: false },
      ],
    }).fields,
  ).toEqual([
    { path: "unreadCount", label: "未读数量", value: 42 },
    { label: "兼容字段", value: false },
  ]);
  for (const invalid of [
    { ...gate, status: { ...gate.status, field: "outcome[0]" } },
    { ...gate, status: { ...gate.status, options: [] } },
    {
      ...gate,
      status: {
        ...gate.status,
        options: [...gate.status.options, ...gate.status.options],
      },
    },
    { ...gate, relations: [{ ...gate.relations[0], direction: "both" }] },
  ])
    expect(() =>
      moduleInspectionSurfaceSchema.parse(surface(invalid)),
    ).toThrow();
});
