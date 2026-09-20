/**
 * 功能概述：验证 SDK 对记录型检查面的声明边界，保证服务端只消费经过校验与冻结的字段、状态和引用。
 * 主要职责：defineFixture 构造内存模块；测试根状态字段和关系字段必须属于对应 view，状态选项与 direction 深冻结。
 * 代码库关系：直接调用 modules.ts 与 information.ts 的公开定义入口，使用 Schema 的 ModuleInspection 类型。
 * 输入输出与副作用：纯声明验证，无数据库、网络、计时器或 Runtime；无效配置须在模块定义时同步拒绝。
 */
import { z, type ModuleInspection } from "@kaguya/schema";
import { expect, it } from "vitest";
import { defineInformationKind, defineInformationModule } from "./index.js";

const rootKind = defineInformationKind({
  kind: "test.gate",
  displayName: "门控",
  description: "测试门控记录。",
  payloadSchema: z.object({ text: z.string(), outcome: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});
const inspection: ModuleInspection = {
  mechanism: [],
  views: [
    {
      id: "gates",
      title: "门控",
      description: "测试根记录。",
      kinds: [rootKind.kind],
      fields: [
        { path: "text", label: "输入" },
        { path: "outcome", label: "结果" },
      ],
    },
    {
      id: "context",
      title: "上下文",
      description: "被引用的输入。",
      kinds: ["test.context"],
      fields: [{ path: "safe", label: "安全" }],
    },
  ],
  surface: {
    version: 1,
    id: "arousal",
    title: "门控",
    layout: { type: "master-detail", areas: ["main"] },
    components: [
      {
        id: "gates",
        type: "record-browser",
        presentation: "attention-gate",
        area: "main",
        viewId: "gates",
        recordKind: rootKind.kind,
        titleField: "text",
        searchFields: ["text"],
        fields: [{ path: "text", label: "输入" }],
        status: {
          field: "outcome",
          options: [{ value: "attend", label: "放行至规划" }],
        },
        labels: {
          directory: "记录",
          search: "搜索",
          placeholder: "输入",
          empty: "暂无",
          mechanism: "机制",
        },
        relations: [
          {
            id: "context",
            title: "上下文",
            viewId: "context",
            kinds: ["test.context"],
            reference: "core:uses-context",
            direction: "forward",
            presentation: "field-grid",
            fields: [{ path: "safe", label: "安全" }],
            empty: "暂无",
            limit: 1,
          },
        ],
      },
    ],
  },
};
const defineFixture = (value: ModuleInspection) =>
  defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "test.gates",
      displayName: "门控",
      summary: "测试门控。",
      description: "测试声明契约。",
      settingsSchema: z.object({}).strict(),
      consumes: [],
      produces: [rootKind],
      selectors: [],
      promptRenderers: [],
      requires: [],
      provides: [],
      inspection: value,
    },
    create: () => ({ provisions: [], subscriptions: [] }),
  });
it("freezes gate status options and forward context declarations", () => {
  const surface = defineFixture(inspection).manifest.inspection!.surface!;
  const browser = surface.components[0]!;
  expect(browser.type).toBe("record-browser");
  if (browser.type !== "record-browser")
    throw new Error("Expected record browser");
  expect(browser.relations[0]!.direction).toBe("forward");
  expect(Object.isFrozen(browser.status!.options[0])).toBe(true);
  expect(Object.isFrozen(browser.relations[0]!.fields)).toBe(true);
});
it("rejects undeclared root status and relation fields or kinds", () => {
  for (const change of ["status", "field", "kind"] as const) {
    const value = structuredClone(inspection);
    const browser = value.surface!.components[0]!;
    if (browser.type !== "record-browser")
      throw new Error("Expected record browser");
    if (change === "status") browser.status!.field = "hidden";
    if (change === "field") browser.relations[0]!.fields[0]!.path = "hidden";
    if (change === "kind") browser.relations[0]!.kinds = ["test.hidden"];
    expect(() => defineFixture(value)).toThrow(
      /Unknown inspection surface record field/u,
    );
  }
});
