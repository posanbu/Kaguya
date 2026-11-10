/**
 * 功能概述：在真实账本上回归千条输入、跨三页冻结引用和跨页 Light/Heavy 持久请求的读取。
 * 主要职责：以 SQL 批量种入旧的不可变原子与引用，再通过真实 InformationSelectorExecutor 授权读取；
 * 同一 fixture 同时检查冻结输入、辅助记忆和持久请求上下文完整性，重复读取必须保持顺序。
 * 代码库关系：使用 database 的生产 schema/repository 与 Heavy 样本构造器；不模拟 ledger 分页。
 * 输入输出与副作用：默认使用 PGlite，指定测试 URL 时使用隔离 PostgreSQL schema；finally 关闭数据库。
 * 此测试只证明持久上下文读取契约；模型和平台副作用由 Server 重放测试验证。
 */
import { expect, it } from "vitest";
import {
  createTestingDatabase,
  createPostgresTestingDatabase,
} from "@kaguya/database/testing";
import { InformationSelectorExecutor } from "@kaguya/engine";
import { atom, fixture } from "./test-fixtures.js";
import { turnMessageContextSelector } from "./message-context.js";
import { lightContextSelector } from "../router/light.js";

it("reads 1000 frozen inputs and complete persisted Light/Heavy context from the database", async () => {
  const url = process.env.KAGUYA_TEST_DATABASE_URL;
  const db = url
    ? await createPostgresTestingDatabase(url)
    : await createTestingDatabase();
  try {
    await db.prepareSchema();
    const f = fixture(Array.from({ length: 1000 }, (_, i) => `message-${i}`));
    // 不生成无关的 999 次引用消息查找；保留真实输入、身份元数据与不可变引用集。
    const messages = f.messages.map((a) => {
      const payload = JSON.parse(JSON.stringify(a.payload));
      delete payload.source.replyTo;
      return atom(a.informationId, a.kind, payload);
    });
    const extra = Array.from({ length: 1036 }, (_, i) =>
      atom(`evidence-${i}`, "test.evidence", {}),
    );
    const turnPayload = JSON.parse(JSON.stringify(f.turn.payload));
    turnPayload.inputs.forEach((input: any) => delete input.source.replyTo);
    turnPayload.memory = [extra.at(-1)!.informationId];
    const turn = atom(
      f.turn.informationId,
      f.turn.kind,
      turnPayload,
      [...extra, ...messages].map((a) => ({
        relation: "core:uses-context",
        informationId: a.informationId,
      })),
    );
    const requests = ["light", "heavy"].map((role) =>
      atom(
        `${role}-request`,
        "core.model.task.requested",
        {
          taskId:
            role === "light" ? "agent.light.decide" : "agent.heavy.respond",
          contextInformationIds: extra.map((a) => a.informationId),
        },
        [
          {
            relation: "core:caused-by",
            informationId:
              role === "light" ? turn.informationId : f.intent.informationId,
          },
          ...extra.map((a) => ({
            relation: "core:uses-context",
            informationId: a.informationId,
          })),
        ],
      ),
    );
    const atoms = [
      atom("runtime-context", "core.runtime.context", {}),
      f.intent,
      turn,
      ...messages,
      ...extra,
      ...requests,
    ];
    await db.information.synchronizeKinds([
      ...new Set(atoms.map((a) => a.kind)),
    ]);
    await db.sql.transaction(async (tx) => {
      const serialized = JSON.stringify(atoms);
      await tx.query(
        `INSERT INTO information_atoms(information_id,kind,occurred_at,source,payload)
        SELECT a->>'informationId',a->>'kind',a->>'occurredAt',a->>'source',a->'payload' FROM jsonb_array_elements($1::jsonb) a`,
        [serialized],
      );
      await tx.query(
        `INSERT INTO information_references(information_id,ordinal,relation,target_information_id)
        SELECT a->>'informationId',r.ordinality-1,r.value->>'relation',r.value->>'informationId'
        FROM jsonb_array_elements($1::jsonb) a, LATERAL jsonb_array_elements(a->'references') WITH ORDINALITY r(value,ordinality)`,
        [serialized],
      );
    });
    for (const [selector, source] of [
      [lightContextSelector, turn.informationId],
      [turnMessageContextSelector, f.intent.informationId],
    ] as const) {
      const first = await new InformationSelectorExecutor(
        db.information,
      ).select(selector, source);
      const ids = new Set(first.map((a) => a.informationId));
      expect(messages.every((a) => ids.has(a.informationId))).toBe(true);
      expect(extra.every((a) => ids.has(a.informationId))).toBe(true);
      expect(ids.size).toBe(first.length);
      const replay = await new InformationSelectorExecutor(
        db.information,
      ).select(selector, source);
      expect(replay).toEqual(first);
    }
  } finally {
    await db.close();
  }
}, 30000);
