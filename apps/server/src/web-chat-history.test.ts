/**
 * 功能概述：在真实 PGlite 账本上验证 Web 私聊历史的登记游标与会话边界。
 * 主要职责：fixture 仅准备账本和合法入站事实，不启动模型或后台订阅；分页用例写入超过
 * 100 条相同时间戳消息，再补写更早发生的消息，确认按登记水位增量读取不会丢失或重复。
 * 代码库关系：直接驱动 web-chat.ts 的 createWebChatHistory，与 HTTP/Runtime 端到端测试
 * 分别覆盖读取层和完整业务链；信息 payload 仍经过正式 inbound kind schema 校验。
 * 输入输出与副作用：每个用例创建并关闭独立内存数据库，只使用合成 UUID 和正文；所有写入
 * 均等待数据库提交，无固定等待或后台任务。跨会话、错误消息种类及不存在的游标必须拒绝。
 */
import { randomUUID } from "node:crypto";

import { createTestingDatabase } from "@kaguya/database/testing";
import { inboundTextInformationKind } from "@kaguya/modules";
import { freezeInformationAtom } from "@kaguya/schema";
import { afterEach, describe, expect, it } from "vitest";

import { createWebChatHistory, InvalidWebChatCursorError } from "./web-chat.js";

const occurredAt = "2026-09-19T08:00:00.000Z";
const databases: Awaited<ReturnType<typeof createTestingDatabase>>[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) await database.close();
}, 15_000);

async function fixture() {
  const database = await createTestingDatabase();
  databases.push(database);
  await database.prepareSchema();
  await database.information.synchronizeKinds([
    "core.runtime.context",
    inboundTextInformationKind.kind,
  ]);
  await database.information.append(
    freezeInformationAtom({
      informationId: "web-history-context",
      kind: "core.runtime.context",
      occurredAt,
      source: "runtime:test",
      payload: {},
      references: [],
    }),
    [],
  );
  const inbound = async (
    conversationId: string,
    informationId: string,
    time = occurredAt,
  ) => {
    const payload = inboundTextInformationKind.payloadSchema.parse({
      text: `正文 ${informationId}`,
      source: {
        platform: "web",
        adapterId: "web.ui.main",
        destination: { kind: "web", conversationId },
        senderId: conversationId,
        platformMessageId: `request-${informationId}`,
      },
    });
    await database.information.append(
      freezeInformationAtom({
        informationId,
        kind: inboundTextInformationKind.kind,
        occurredAt: time,
        source: "adapter:web",
        payload,
        references: [
          {
            relation: "core:context",
            informationId: "web-history-context",
          },
        ],
      }),
      [
        {
          relation: "core:context",
          targetKinds: ["core.runtime.context"],
          required: true,
          multiple: false,
        },
      ],
    );
  };
  return {
    database,
    reader: createWebChatHistory(database.information),
    inbound,
  };
}

describe("Web chat history registration cursors", () => {
  it("paginates equal timestamps without gaps and includes later backdated inserts", async () => {
    const f = await fixture();
    const conversationId = randomUUID();
    // ID 顺序与登记顺序相反，防止 timestamp/ID 分页碰巧通过。
    const ids = Array.from(
      { length: 105 },
      (_, index) => `inbound-${String(105 - index).padStart(3, "0")}`,
    );
    for (const id of ids) await f.inbound(conversationId, id);
    await f.inbound(randomUUID(), "foreign-before-pagination");

    const first = await f.reader.read({ conversationId });
    expect(first.messages).toHaveLength(100);
    expect(new Set(first.messages.map((message) => message.id))).toEqual(
      new Set(ids.slice(0, 100)),
    );
    expect(first.cursor.inbound).toBe(ids[99]);
    expect(first.hasMore).toBe(true);

    await f.inbound(
      conversationId,
      "later-backdated-inbound",
      "2026-09-18T08:00:00.000Z",
    );
    const next = await f.reader.read({
      conversationId,
      afterInbound: first.cursor.inbound!,
    });
    expect(next.messages).toHaveLength(6);
    expect(new Set(next.messages.map((message) => message.id))).toEqual(
      new Set([...ids.slice(100), "later-backdated-inbound"]),
    );
    expect(next.cursor.inbound).toBe("later-backdated-inbound");
    expect(next.hasMore).toBe(false);
    expect(
      new Set(
        [...first.messages, ...next.messages].map((message) => message.id),
      ).size,
    ).toBe(106);

    const rebuilt = createWebChatHistory(f.database.information);
    expect(await rebuilt.read({ conversationId })).toEqual(first);
    expect(
      await rebuilt.read({
        conversationId,
        afterInbound: next.cursor.inbound!,
      }),
    ).toMatchObject({ messages: [], cursor: next.cursor, hasMore: false });
  });

  it("rejects foreign, wrong-kind and missing cursors before returning history", async () => {
    const f = await fixture();
    const conversationA = randomUUID();
    const conversationB = randomUUID();
    await f.inbound(conversationA, "conversation-a-inbound");
    await f.inbound(conversationB, "conversation-b-inbound");

    for (const afterInbound of [
      "conversation-b-inbound",
      "web-history-context",
      "missing-inbound",
    ]) {
      await expect(
        f.reader.read({ conversationId: conversationA, afterInbound }),
      ).rejects.toBeInstanceOf(InvalidWebChatCursorError);
    }
    await expect(
      f.reader.read({
        conversationId: conversationA,
        afterOutbound: "conversation-a-inbound",
      }),
    ).rejects.toBeInstanceOf(InvalidWebChatCursorError);
    expect(
      (await f.reader.read({ conversationId: conversationA })).messages.map(
        (message) => message.id,
      ),
    ).toEqual(["conversation-a-inbound"]);
  });
});
