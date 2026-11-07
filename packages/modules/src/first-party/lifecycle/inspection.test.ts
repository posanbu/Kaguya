/**
 * 功能概述：验证 Lifecycle 的正式调度目录声明覆盖当前 one-shot 协议，避免 UI 指向旧 heartbeat 视图。
 * 直接对照 scheduler 的五个正式 Kind；不启动 Runtime、数据库或调度器，不改变行为等待预算。
 */
import { expect, it } from "vitest";
import { oneShotInformationKinds } from "@kaguya/scheduler";
import { createLifecycleModule } from "./index.js";
it("declares the current scheduler facts alongside activity and observation views", () => {
  const inspection = createLifecycleModule({ timeZone: "Asia/Shanghai" })
    .manifest.inspection!;
  const view = inspection.views.find((view) => view.id === "schedules");
  expect(view?.kinds).toEqual(oneShotInformationKinds.map((kind) => kind.kind));
  expect(inspection.views.map((view) => view.id)).toEqual(
    expect.arrayContaining(["activity", "gates", "wakes", "schedules"]),
  );
});
