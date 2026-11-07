/**
 * 功能概述：定义管理入口独立 GUI 任务的持久来源与唯一终态，供 GuiTaskService 和 Runtime 注册。
 * requested 保存宿主冻结的环境、观察、激活与路由；客户端只提供 UUID 和提示词。
 * terminal 关联原请求和实际 native run，停止只表示不再推进，不表示已撤回外部效果。
 * definitions 无 I/O；可靠投递、任务去重和停止仍使用 InformationCore 与 NativeToolStore。
 */
import { z } from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";
const id = z.string().min(1);
export const guiTaskRequestedKind = defineInformationKind({
  kind: "agent.gui.task.requested.v1",
  displayName: "GUI 任务请求",
  description: "管理入口提交的独立桌面任务，宿主冻结执行依据。",
  payloadSchema: z
    .object({
      taskRequestId: z.string().uuid(),
      prompt: z.string().trim().min(1).max(16000),
      environmentId: id,
      scope: id,
      workflowId: id,
      generation: z.number().int().nonnegative(),
      revision: id,
      observationId: id,
      turn: z.object({ claimInformationId: id }).strict(),
      activation: z
        .object({ instanceId: id, definitionId: z.literal("agent.heavy") })
        .strict(),
      selectionPolicy: z
        .object({ tier: z.literal("heavy"), routeId: id })
        .strict(),
    })
    .strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": { required: true, multiple: true },
  },
  log: { enabled: false },
});
export const guiTaskTerminalKind = defineInformationKind({
  kind: "agent.gui.task.terminal.v1",
  displayName: "GUI 任务终态",
  description: "关联原任务的实际完成、失败或停止，不承诺撤回既有输入。",
  payloadSchema: z
    .object({
      status: z.enum(["completed", "failed", "stopped"]),
      reason: id,
      runInformationId: id.nullable(),
      output: z.string().nullable(),
    })
    .strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [guiTaskRequestedKind.kind],
    },
    "core:status-of": {
      required: true,
      multiple: false,
      targetKinds: [guiTaskRequestedKind.kind],
    },
  },
  log: { enabled: false },
});
