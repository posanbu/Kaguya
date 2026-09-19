/**
 * 功能概述：验证 Planner 与消息组织的请求 Surface 声明以及 SDK 的能力、归属字段和任务模式边界。
 * 主要职责：用真实 firstPartyInspection 构建最小模块，检查深冻结，拒绝缺失模型能力、请求 Kind、归属字段与错配任务。
 * 代码库关系：覆盖 inspection.ts 与 SDK defineInformationModule 的集成，不运行模型、数据库或异步订阅。
 * 输入输出与副作用：只解析和修改独立的元数据副本；不改全局 Manifest，不请求网络。
 */
import {
  moduleInspectionSchema,
  z,
  type ModuleInspection,
} from "@kaguya/schema";
import { defineInformationModule, defineModuleCapability } from "@kaguya/sdk";
import { expect, it } from "vitest";
import { firstPartyInspection } from "./inspection.js";

const definitions = [
  "agent.heartflow.online",
  "agent.message-composer",
] as const;
function define(inspection: ModuleInspection, hasModelCapability = true) {
  return defineInformationModule({
    manifest: {
      protocolVersion: 1,
      moduleVersion: "1.0.0",
      definitionId: "test.request-surface",
      displayName: "模型请求检查",
      summary: "验证请求声明。",
      description: "只有模块拥有的模型请求才能进入领域检查。",
      settingsSchema: z.object({}).strict(),
      consumes: [],
      produces: [],
      selectors: [],
      promptRenderers: [],
      requires: hasModelCapability
        ? [defineModuleCapability("kaguya:model-task", 1)]
        : [],
      provides: [],
      inspection,
    },
    create: () => ({ provisions: [], subscriptions: [] }),
  });
}
it.each(definitions)(
  "freezes the request surface declared by %s",
  (definitionId) => {
    const inspection = moduleInspectionSchema.parse(
      firstPartyInspection[definitionId],
    );
    const module = define(inspection);
    const browser = module.manifest.inspection!.surface!.components[0]!;
    expect(browser.type).toBe("model-request-browser");
    expect(Object.isFrozen(browser)).toBe(true);
    expect(Object.isFrozen(module.manifest.inspection!.views[0]!.fields)).toBe(
      true,
    );
    if (browser.type === "model-request-browser") {
      expect(browser.taskId).toBe(
        definitionId === "agent.heartflow.online"
          ? "agent.turn.plan"
          : "agent.message.compose",
      );
    }
  },
);
it("requires declared model capability and the persisted request root", () => {
  const inspection = moduleInspectionSchema.parse(
    firstPartyInspection[definitions[0]],
  );
  expect(() => define(inspection, false)).toThrow(
    "Invalid inspection model request contract",
  );
  inspection.views[0]!.kinds = ["core.model.task.completed"];
  expect(() => define(inspection)).toThrow(
    "Invalid inspection model request contract",
  );
});
it("rejects missing ownership metadata and mismatched task projection", () => {
  const inspection = moduleInspectionSchema.parse(
    firstPartyInspection[definitions[0]],
  );
  inspection.views[0]!.fields = inspection.views[0]!.fields.filter(
    (field) => field.path !== "activation.definitionId",
  );
  expect(() => define(inspection)).toThrow(
    "Invalid inspection model request contract",
  );
  const wrongTask = moduleInspectionSchema.parse(
    firstPartyInspection[definitions[0]],
  );
  const browser = wrongTask.surface!.components[0]!;
  if (browser.type !== "model-request-browser")
    throw new Error("Expected model requests");
  browser.taskId = "agent.message.compose";
  expect(() => define(wrongTask)).toThrow(
    "Invalid inspection model request task mode",
  );
});
