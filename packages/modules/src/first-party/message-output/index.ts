/**
 * 功能概述：默认输出处理器把已授权助手内容登记到唯一投递槽，与 TTS 插件互斥。
 * textMessageOutputModule 保留文字、表情、有序 text/mediaRef 段及冻结请求 ID，纯媒体不丢弃。
 * 有序内容段经 schema 校验并复制，避免把账本的深只读数组作为可变投递载荷。
 * 依赖 message kinds 和 SDK registerOnce；只创建投递事实，不读取资源或调用平台。
 * Runtime 负责媒体来源与目标授权、字节校验和行动恢复；speech、turn 与 assistant 因果引用保持原值。
 */
import { outboundContentSegmentsSchema, z } from "@kaguya/schema";
import { defineInformationModule, onInformation } from "@kaguya/sdk";
import {
  authorizedAssistantOutputInformationKind,
  deliveryRequestedInformationKind,
  messageOutputProcessorReady,
} from "../kinds/message.js";

export const textMessageOutputModule = defineInformationModule({
  manifest: {
    protocolVersion: 1,
    definitionId: "agent.message-output.text",
    moduleVersion: "1.0.0",
    displayName: "文字输出",
    summary: "将已授权正文转换成文字投递请求。",
    description:
      "Composition 在不存在其他输出处理器时补入本模块，由 capability 预检保证只有一个处理器。",
    settingsSchema: z.strictObject({}),
    consumes: [authorizedAssistantOutputInformationKind],
    produces: [deliveryRequestedInformationKind],
    selectors: [],
    promptRenderers: [],
    requires: [],
    provides: [messageOutputProcessorReady],
    inspection: {
      mechanism: [
        "只消费已经通过目标授权的助手正文。",
        "每个授权事实最多派生一个文字投递请求。",
      ],
      views: [
        {
          id: "text-deliveries",
          title: "文字投递",
          description: "默认输出策略登记的平台投递请求。",
          kinds: [deliveryRequestedInformationKind.kind],
          fields: [
            { path: "platform", label: "平台" },
            { path: "adapterId", label: "适配器" },
            { path: "message.kind", label: "消息类型" },
          ],
        },
      ],
    },
  },
  create: () => ({
    provisions: [
      {
        capability: messageOutputProcessorReady,
        value: Object.freeze({ ready: true }),
      },
    ],
    subscriptions: [
      onInformation(
        authorizedAssistantOutputInformationKind,
        { subscriptionId: "agent.message-output.text", delivery: "durable" },
        async (authorized, context) => {
          const assistantInformationId = authorized.references.find(
            (reference) => reference.relation === "core:caused-by",
          )?.informationId;
          if (!assistantInformationId)
            throw new Error(
              "Authorized output is missing its assistant source",
            );
          if (
            authorized.payload.contentSegments &&
            !authorized.payload.mediaRequestInformationId
          )
            throw new Error(
              "Ordered output is missing its frozen model request",
            );
          await context.registerOnce(
            "agent.message-output.text.delivery.v1",
            authorized.informationId,
            deliveryRequestedInformationKind,
            {
              causedByInformationId: assistantInformationId,
              payload: {
                adapterId: authorized.payload.source.adapterId,
                platform: authorized.payload.source.platform,
                destination: authorized.payload.source.destination,
                message: authorized.payload.contentSegments
                  ? {
                      kind: "content",
                      text: authorized.payload.text,
                      segments: outboundContentSegmentsSchema.parse(
                        authorized.payload.contentSegments,
                      ),
                      requestInformationId:
                        authorized.payload.mediaRequestInformationId!,
                      ...(authorized.payload.expression
                        ? { expression: authorized.payload.expression }
                        : {}),
                    }
                  : {
                      kind: "text",
                      text: authorized.payload.text,
                      ...(authorized.payload.expression
                        ? { expression: authorized.payload.expression }
                        : {}),
                    },
                turn: authorized.payload.turn,
                ...(authorized.payload.speech
                  ? { speech: authorized.payload.speech }
                  : {}),
              },
              references:
                authorized.payload.turn == null
                  ? []
                  : [
                      {
                        relation: "agent:turn-claim" as const,
                        informationId:
                          authorized.payload.turn.claimInformationId,
                      },
                      {
                        relation: "agent:turn-candidate" as const,
                        informationId:
                          authorized.payload.turn.candidateInformationId,
                      },
                    ],
            },
          );
        },
      ),
    ],
  }),
});
