/**
 * 功能概述：定义跨会话发送的宿主授权能力和审计事实，复用统一 message intent。
 * 主要职责：prepare 校验意图并提供隔离的冻结 Prompt；stage 暂存 Composer 正文，确认事实唤醒原订阅释放投递。
 * 代码库关系：Runtime 提供能力，composition 向 Composer 注入 token；HTTP 管理端只能调用宿主的确认入口。
 * 输入输出与副作用：事实可持久化但不能自行授予权限；真实授权由宿主私有状态核验，重启默认失效。
 */
import {
  z,
  type CompiledPrompt,
  type DeepReadonly,
  type InformationAtom,
} from "@kaguya/schema";
import { defineInformationKind, defineModuleCapability } from "@kaguya/sdk";
import {
  messageTargetSchema,
  turnProvenanceSchema,
} from "./information-kinds.js";
export interface MessageAuthorization {
  prepare(intent: DeepReadonly<InformationAtom>): Promise<
    | {
        prompt: CompiledPrompt;
        contextAtoms: readonly DeepReadonly<InformationAtom>[];
      }
    | undefined
  >;
  stage(assistant: DeepReadonly<InformationAtom>): Promise<boolean>;
}
export const messageAuthorizationCapability =
  defineModuleCapability<MessageAuthorization>(
    "kaguya:message-authorization",
    1,
  );
export const targetAuthorizedInformationKind = defineInformationKind({
  kind: "agent.message.target.authorized",
  displayName: "Approved message context",
  description:
    "Management-approved isolated instructions; the fact alone is not a capability.",
  payloadSchema: z
    .object({
      target: messageTargetSchema,
      turn: turnProvenanceSchema,
      instruction: z.string().min(1).max(16000),
      expiresAt: z.iso.datetime(),
    })
    .strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: ["core.runtime.context"],
    },
    "core:uses-context": {
      required: true,
      multiple: false,
      targetKinds: ["agent.turn.context.completed"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: ({ payload }) => ({
      event: "message.target.authorized",
      adapterId: payload.target.adapterId,
      platform: payload.target.platform,
      targetKind: payload.target.destination.kind,
    }),
  },
});
export const messageConfirmedInformationKind = defineInformationKind({
  kind: "agent.message.content.confirmed",
  displayName: "Message content confirmed",
  description: "Authenticated management approved an exact generated message.",
  payloadSchema: z
    .object({ assistantInformationId: z.string().min(1) })
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
      targetKinds: ["core.message.assistant.text"],
    },
  },
  log: {
    enabled: true,
    level: "info",
    project: () => ({ event: "message.content.confirmed" }),
  },
});
