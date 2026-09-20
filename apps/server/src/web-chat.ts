/**
 * 功能概述：把持久化信息账本投影为 Web 私聊历史，不保存第二份聊天记录。
 * 主要职责：createWebChatHistory 返回受限 reader；read 按会话读取入站与已投递回复，
 * 两条登记水位分别分页，避免模型延迟、相同时间戳或补写历史造成丢失。
 * 代码库关系：server.ts 注入当前账本，app.ts 在 Gateway 认证后调用；正文只来自
 * core.message.inbound.text 与已完成 core.delivery.delivered 对应的 delivery request。
 * 输入输出与副作用：每次读取每类最多 100 条，游标必须属于同一会话及消息种类；
 * 仅查询数据库，不写 Atom、不生成模型回复、不返回 Prompt、内部配置或未送达正文。
 */
import {
  deliveryRequestedInformationKind,
  inboundTextInformationKind,
} from "@kaguya/modules";
import { deliveryDeliveredInformationKind } from "@kaguya/runtime";
import {
  webConversationIdSchema,
  type DeepReadonly,
  type InformationAtom,
  type JsonObject,
  type WebChatHistory,
  type WebChatMessage,
} from "@kaguya/schema";
import type { InformationSelectorLedger } from "@kaguya/sdk";

const PAGE_SIZE = 100;
const WEB_ADAPTER_ID = "web.ui.main";

export interface WebChatHistoryQuery {
  readonly conversationId: string;
  readonly afterInbound?: string;
  readonly afterOutbound?: string;
}

export interface WebChatHistoryReader {
  read(query: WebChatHistoryQuery): Promise<WebChatHistory>;
}

export class InvalidWebChatCursorError extends Error {
  constructor() {
    super("Chat history cursor does not belong to this conversation");
    this.name = "InvalidWebChatCursorError";
  }
}

export function createWebChatHistory(
  ledger: Pick<InformationSelectorLedger, "find">,
): WebChatHistoryReader {
  async function page(
    kind: string,
    payloadContains: JsonObject,
    after?: string,
  ) {
    if (after !== undefined) {
      const cursor = await ledger.find({
        kinds: [kind],
        informationIds: [after],
        payloadContains,
        limit: 1,
      });
      if (cursor.length !== 1) throw new InvalidWebChatCursorError();
    }
    return ledger.find({
      kinds: [kind],
      payloadContains,
      registrationOrder: true,
      ...(after === undefined ? {} : { afterInformationId: after }),
      order: "asc",
      limit: PAGE_SIZE + 1,
    });
  }

  return {
    async read(query) {
      const conversationId = webConversationIdSchema.parse(
        query.conversationId,
      );
      const target = { kind: "web", conversationId };
      const [inboundPage, outboundPage] = await Promise.all([
        page(
          inboundTextInformationKind.kind,
          {
            source: {
              platform: "web",
              adapterId: WEB_ADAPTER_ID,
              destination: target,
            },
          },
          query.afterInbound,
        ),
        page(
          deliveryDeliveredInformationKind.kind,
          { platform: "web", adapterId: WEB_ADAPTER_ID, target },
          query.afterOutbound,
        ),
      ]);
      const inbounds = inboundPage.slice(0, PAGE_SIZE);
      const outbounds = outboundPage.slice(0, PAGE_SIZE);
      const requestIds = outbounds.flatMap((atom) => {
        const id = deliveryRequestId(atom);
        return id === undefined ? [] : [id];
      });
      const requests =
        requestIds.length === 0
          ? []
          : await ledger.find({
              kinds: [deliveryRequestedInformationKind.kind],
              informationIds: requestIds,
              payloadContains: {
                platform: "web",
                adapterId: WEB_ADAPTER_ID,
                destination: target,
              },
              limit: PAGE_SIZE,
            });
      const requestById = new Map(
        requests.map((atom) => [atom.informationId, atom]),
      );
      const messages: WebChatMessage[] = inbounds.map((atom) => {
        const payload = inboundTextInformationKind.payloadSchema.parse(
          atom.payload,
        );
        return {
          id: atom.informationId,
          role: "user",
          text: payload.text,
          createdAt: atom.occurredAt,
          requestId: payload.source.platformMessageId,
        };
      });
      for (const atom of outbounds) {
        const request = requestById.get(deliveryRequestId(atom) ?? "");
        if (request === undefined) continue;
        const payload = deliveryRequestedInformationKind.payloadSchema.parse(
          request.payload,
        );
        messages.push({
          id: atom.informationId,
          role: "assistant",
          text: payload.message.text,
          createdAt: atom.occurredAt,
        });
      }
      messages.sort(
        (left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id),
      );
      const inbound = inbounds.at(-1)?.informationId ?? query.afterInbound;
      const outbound = outbounds.at(-1)?.informationId ?? query.afterOutbound;
      return {
        conversationId,
        messages,
        cursor: {
          ...(inbound === undefined ? {} : { inbound }),
          ...(outbound === undefined ? {} : { outbound }),
        },
        hasMore:
          inboundPage.length > PAGE_SIZE || outboundPage.length > PAGE_SIZE,
      };
    },
  };
}

function deliveryRequestId(atom: DeepReadonly<InformationAtom>) {
  return atom.references.find(
    (reference) => reference.relation === "core:status-of",
  )?.informationId;
}
