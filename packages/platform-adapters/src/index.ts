/**
 * 功能概述：聚合 platform-adapters 的公共契约、OneBot 编解码、NapCat 组件
 * 与 Web 正规化器，作为 Runtime 和应用层之间的单一导入面。
 * 主要职责：导出窄 `InformationIngress`/`InboundReceipt`、平台消息与 transport
 * 类型，以及 OneBot、NapCat、Web 实现；本文件不创建任何 Runtime 兼容包装。
 * 代码库关系：`@kaguya/runtime` 结构性实现 ingress，`apps/server` 和 `apps/demo`
 * 仅从本入口消费 adapter 契约；具体类型与实现分布在相邻源文件。
 * 输入输出与副作用：仅执行静态 re-export，无 I/O 或状态变化。
 */
export type {
  InboundReceipt,
  InformationIngress,
  PlatformDeliveryReceipt,
  PlatformInboundMessage,
  PlatformMessageMention,
  PlatformMessageSender,
  PlatformMessageTarget,
  PlatformName,
  PlatformOutboundTransport,
  PlatformReplySender,
} from "./types.js";
export {
  buildOneBotSendAction,
  normalizeOneBotMessageEvent,
  type NormalizeOneBotOptions,
  type OneBotActionRequest,
  type OneBotMessageSegment,
} from "./onebot.js";
export {
  NapCatActionClient,
  NapCatOneBotAdapter,
  type JsonMessageTransport,
  type NapCatActionClientOptions,
  type NapCatInboundErrorContext,
  type NapCatOneBotAdapterOptions,
} from "./napcat.js";
export {
  normalizeWebInboundMessage,
  type NormalizeWebInboundOptions,
  type WebInboundInput,
} from "./web.js";
