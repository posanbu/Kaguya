/**
 * 功能概述：验证 record-browser 的 wire 边界，拒绝表达式式字段路径、无界分组和不合法来源状态。
 * 代码库关系：直接消费 inspection.ts；仅纯 Schema 解析，不做网络或数据库操作。
 */
import { expect, it } from "vitest";
import {
  moduleInspectionSurfaceSchema,
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
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
