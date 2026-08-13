export type {
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
