/**
 * 功能概述：验证记忆联想 Manifest 的 Surface 在 SDK 中被校验及深冻结。
 * 主要职责：确认字段/来源声明可用，同时拒绝借关联视图读取未声明字段或 Kind；不执行联想处理器。
 */
import { expect, it } from "vitest";
import { moduleInspectionSchema } from "@kaguya/schema";
import { defineInformationModule } from "@kaguya/sdk";
import { associationModule } from "./index.js";
it("freezes the association record browser and rejects undeclared source projections", () => {
  const surface = associationModule.manifest.inspection!.surface!;
  expect(Object.isFrozen(surface.components)).toBe(true);
  const inspection = moduleInspectionSchema.parse(
    associationModule.manifest.inspection!,
  );
  const browser = inspection.surface!.components.find(
    (item) => item.type === "record-browser",
  )!;
  browser.relations[1]!.source!.fields.push({ path: "apiKey", label: "密钥" });
  expect(() =>
    defineInformationModule({
      ...associationModule,
      manifest: { ...associationModule.manifest, inspection },
    }),
  ).toThrow("Unknown inspection surface record field");
});
