/**
 * 功能概述：定义平台 adapter 与 Core ingress 之间的最小结构契约，
 * 使 Web、NapCat 和 Runtime 只共享正规化内容、外部平台身份与接收回执。
 * 主要职责：`PlatformInboundMessage` 保留 adapter/platform、外部 message ID、
 * occurredAt、sender、destination、mentions 与 raw；`InformationIngress.submit` 是唯一入站能力；
 * `InboundReceipt` 仅暴露根 information ID 和本次提交观察到的平台投递结果；出站只保留
 * 可表达完整 `OutboundMessageContent` 的 `PlatformOutboundTransport.sendMessage`。
 * 代码库关系：`onebot.ts`/`web.ts` 产生入站结构，`napcat.ts`、Server Web gateway
 * 仅持有 ingress，`KaguyaRuntime` 结构性实现该接口并生成 Core `informationId`。
 * 输入输出与副作用：本文件仅定义类型，无 I/O；`platformMessageId` 是外部数据，
 * 不是 Core identity，且契约中不存在 adapter 自造的跟踪身份。
 */
import type {
  InformationId,
  OutboundMessageContent,
  PlatformDestination,
} from "@kaguya/schema";

export type PlatformName = "qq" | "web";

export type PlatformMessageTarget = PlatformDestination;

export interface PlatformMessageSender {
  readonly userId: string;
  readonly nickname?: string;
  readonly card?: string;
}

export type PlatformMessageMention =
  { readonly kind: "user"; readonly id: string } | { readonly kind: "all" };

export interface PlatformInboundMessage {
  readonly platform: PlatformName;
  readonly adapterId: string;
  readonly selfId?: string;
  readonly platformMessageId: string;
  readonly occurredAt: string;
  readonly text: string;
  readonly mentions: readonly PlatformMessageMention[];
  readonly target: PlatformMessageTarget;
  readonly sender: PlatformMessageSender;
  readonly raw: Record<string, unknown>;
}

export interface PlatformDeliveryReceipt {
  readonly ok: boolean;
  readonly adapterId: string;
  readonly platform: PlatformName;
  readonly target: PlatformMessageTarget;
  readonly platformMessageId?: string;
  readonly error?: string;
  readonly raw?: unknown;
}

export interface InboundReceipt {
  readonly rootInformationId: InformationId;
  readonly deliveries: readonly PlatformDeliveryReceipt[];
}

export interface InformationIngress {
  submit(input: PlatformInboundMessage): Promise<InboundReceipt>;
}

export interface PlatformOutboundTransport {
  sendMessage(
    target: PlatformMessageTarget,
    message: OutboundMessageContent,
    metadata?: Record<string, unknown>,
  ): Promise<PlatformDeliveryReceipt>;
}
