/**
 * 功能概述：定义跨会话发送的宿主授权能力和审计事实，复用统一 message intent。
 * conversation 冻结当前范围背景与不透明目标引用；route 仅接受已持久化的获胜 Planner 决策，自动投递仍由宿主校验。
 * 主要职责：prepare 校验意图并提供隔离的冻结 Prompt；stage 暂存 Composer 正文，确认事实唤醒原订阅释放投递。
 * 代码库关系：Runtime 提供能力，composition 向 Composer 注入 token；HTTP 管理端只能调用宿主的确认入口。
 * 输入输出与副作用：事实可持久化但不能自行授予权限；真实授权由宿主私有状态核验，重启默认失效。
 * 展示契约：中文名称与职责说明由定义直接提供给 Inspection 和 WebUI，稳定 kind 与协议字段保持不变。
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
export const plannerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z
    .object({
      kind: z.enum(["group", "private"]),
      reference: z.string().min(1).max(100),
      instruction: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unresolved"),
      reason: z.enum([
        "ambiguous",
        "unrecognized",
        "unreachable",
        "not-found",
        "unauthorized",
      ]),
    })
    .strict(),
]);
export type PlannerTarget = z.infer<typeof plannerTargetSchema>;
export const conversationContextInformationKind = defineInformationKind({
  kind: "agent.conversation.context.frozen",
  displayName: "冻结会话上下文",
  description:
    "保存当前回合最小化的会话与人物背景及不透明目标路由引用；该事实本身不能授予发送权限。",
  payloadSchema: z
    .object({
      background: z
        .object({
          scope: z.enum(["group", "private", "web"]),
          name: z.string(),
          participants: z.array(
            z
              .object({
                label: z.string(),
                name: z.string(),
                identityStatus: z.string(),
                relation: z.enum(["speaker", "participant", "mentioned"]),
              })
              .strict(),
          ),
        })
        .strict(),
      resolution: z
        .object({
          status: z.enum(["available", "unavailable"]),
          targets: z.array(
            z
              .object({
                kind: z.enum(["group", "private"]),
                name: z.string(),
                relation: z.enum(["current", "speaker", "mentioned"]),
                status: z.enum([
                  "resolved",
                  "ambiguous",
                  "unauthorized",
                  "unrecognized",
                ]),
                reference: z.string().nullable(),
              })
              .strict(),
          ),
        })
        .strict(),
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
      event: "conversation.context",
      status: payload.resolution.status,
    }),
  },
});
export interface MessageAuthorization {
  conversation?(
    turn: DeepReadonly<InformationAtom>,
  ): Promise<DeepReadonly<InformationAtom>>;
  route?(
    turn: DeepReadonly<InformationAtom>,
    decision: DeepReadonly<InformationAtom>,
  ): Promise<{ status: "accepted" | "failed"; reason?: string }>;

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
  displayName: "跨会话目标授权事实",
  description:
    "管理端批准隔离指令后记录目标、回合及有效期；Composer 仍需通过宿主私有能力验证，单独重放此事实不能获得发送权限。",
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
  displayName: "消息正文已确认",
  description:
    "管理端确认某条生成正文后记录其标识；原 Composer 订阅经宿主验证后释放对应投递，确认不适用于其他正文。",
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
