/**
 * 功能概述：用 PGlite 和可选真实 PostgreSQL 事务验证观察快照、独立水位、来源隔离、失败恢复及并发唯一性。
 * fixture 每例独立数据库，写入与确认均 await 持久边界；并发 SQL 屏障使用 8 秒/20 毫秒有界轮询且 finally 释放事务。
 * 代码库关系：经公开 observations 与 information API 验证生产仓储；PostgreSQL 分支实际关闭并重连连接池，PGlite 只重建仓储对象。
 * 输入输出与副作用：合成群聊来源与确认原子，不调用模型/平台，afterEach 关闭测试数据库。
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  freezeInformationAtom,
  informationIdSchema,
  sceneIdentity,
  type SceneAddress,
} from "@kaguya/schema";
import type { ObservationSnapshot } from "@kaguya/sdk";
import { ObservationConflictError } from "@kaguya/sdk";
import { KaguyaDatabase } from "./index.js";
import {
  createTestingDatabase,
  createPostgresTestingDatabaseScope,
  type PostgresTestingDatabaseScope,
} from "./testing.js";
import type { SqlDatabase } from "./driver.js";
const url = process.env.KAGUYA_TEST_DATABASE_URL;
if (process.env.KAGUYA_REQUIRE_POSTGRES_TESTS === "1" && !url)
  throw new Error("PostgreSQL test URL required");
const inbound = "core.message.inbound.text",
  resultKind = "test.observation.completed";
const address: SceneAddress = {
  platform: "qq",
  adapterId: "test",
  destination: { kind: "group", groupId: "g" },
};
const input = {
  consumerId: "foreground",
  policyVersion: "v1",
  address,
  kinds: [inbound],
  resultKind,
};
for (const postgres of [false, true]) {
  describe.skipIf(postgres && !url)(
    postgres ? "PostgreSQL observations" : "PGlite observations",
    () => {
      let db: KaguyaDatabase;
      let scope: PostgresTestingDatabaseScope | undefined;
      async function reconnect() {
        if (scope) {
          await db.close();
          db = await scope.reconnect();
        } else {
          db = new KaguyaDatabase(db.sql);
        }
      }
      // 在真实事务提交前抛错，断言 PostgreSQL/PGlite 都回滚快照或水位更新。
      function failBeforeCommit(statement: string): KaguyaDatabase {
        const underlying = db.sql;
        const interrupted: SqlDatabase = {
          query: underlying.query.bind(underlying),
          exec: underlying.exec.bind(underlying),
          close: async () => undefined,
          transaction: (run) =>
            underlying.transaction((tx) =>
              run({
                exec: tx.exec.bind(tx),
                query: async <Row extends Record<string, unknown>>(
                  sql: string,
                  values?: readonly unknown[],
                ) => {
                  const result = await tx.query<Row>(sql, values);
                  if (sql.includes(statement))
                    throw new Error("simulated-precommit-interruption");
                  return result;
                },
              }),
            ),
        };
        return new KaguyaDatabase(interrupted);
      }
      beforeEach(async () => {
        scope = postgres
          ? await createPostgresTestingDatabaseScope(url!)
          : undefined;
        db = scope ? await scope.connect() : await createTestingDatabase();
        await db.prepareSchema();
        await db.information.synchronizeKinds([inbound, resultKind]);
      });
      afterEach(async () => {
        if (scope) await scope.close();
        else await db?.close();
      });
      async function append(
        source: SceneAddress = address,
        occurredAt = "2026-09-25T00:00:00.000Z",
        senderId = "a",
      ) {
        const id = informationIdSchema.parse(randomUUID());
        await db.information.append(
          freezeInformationAtom({
            informationId: id,
            kind: inbound,
            occurredAt,
            source: "test:observation",
            payload: {
              source: { ...source, senderId },
              text: "synthetic evidence",
            },
            references: [],
          }),
          [],
        );
        return id;
      }
      async function result(
        snapshot: Pick<
          ObservationSnapshot,
          "observationId" | "sourceInformationIds" | "contextInformationIds"
        >,
        ids: readonly string[] = [
          ...snapshot.sourceInformationIds,
          ...snapshot.contextInformationIds,
        ],
        kind = resultKind,
      ) {
        const id = informationIdSchema.parse(randomUUID());
        await db.information.append(
          freezeInformationAtom({
            informationId: id,
            kind,
            occurredAt: "2026-09-25T00:00:01.000Z",
            source: "test:observation",
            payload: { observationId: snapshot.observationId },
            references: ids.map((source) => ({
              relation: "core:uses-context",
              informationId: informationIdSchema.parse(source),
            })),
          }),
          [{ relation: "core:uses-context", multiple: true, required: true }],
        );
        return id;
      }
      describe("persistent observations", () => {
        it("freezes across ticks, preserves late evidence and restores failed input after reconstruction", async () => {
          const a = await append(),
            b = await append();
          const first = (await db.observations.freezeNext(input))!;
          expect(first.sourceInformationIds).toEqual([a, b]);
          const c = await append(address, "2025-01-01T00:00:00.000Z");
          await db.observations.fail(
            first.observationId,
            "provider-unavailable",
          );
          await reconnect();
          const reopened = db;
          const retry = (await reopened.observations.freezeNext(input))!;
          expect(retry.observationId).toBe(first.observationId);
          expect(retry.sourceInformationIds).toEqual([a, b]);
          expect(
            (await reopened.observations.progress(input))?.throughPosition,
          ).toBe("0");
          const proof = await result(first);
          await reopened.observations.finish(first.observationId, proof);
          expect(
            (await reopened.observations.freezeNext(input))
              ?.sourceInformationIds,
          ).toEqual([c]);
          expect((await db.information.get(c))?.occurredAt).toBe(
            "2025-01-01T00:00:00.000Z",
          );
        });
        it("keeps foreground and memory progress independent, with one immutable open snapshot per stream", async () => {
          await append();
          const [a, b] = await Promise.all([
            db.observations.freezeNext(input),
            db.observations.freezeNext(input),
          ]);
          expect(a?.observationId).toBe(b?.observationId);
          const memory = { ...input, consumerId: "memory" };
          const other = (await db.observations.freezeNext(memory))!;
          expect(other.observationId).not.toBe(a!.observationId);
          await db.observations.finish(a!.observationId, await result(a!));
          expect(
            (await db.observations.progress(memory))?.throughPosition,
          ).toBe("0");
          expect(
            (await db.observations.read(other.observationId))?.status,
          ).toBe("frozen");
        });
        it("advances only a complete page and rejects changed contracts or unrelated completion", async () => {
          const a = await append(),
            b = await append(),
            c = await append();
          const page = (await db.observations.freezeNext({
            ...input,
            limit: 2,
          }))!;
          expect(page.sourceInformationIds).toEqual([a, b]);
          expect(page.hasMore).toBe(true);
          await expect(
            db.observations.freezeNext({ ...input, kinds: [resultKind] }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          await expect(
            db.observations.finish(page.observationId, await result(page, [a])),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
          const proof = await result(page);
          const completed = await db.observations.finish(
            page.observationId,
            proof,
          );
          expect(
            await db.observations.finish(page.observationId, proof),
          ).toEqual(completed);
          await expect(
            db.observations.finish(page.observationId, await result(page)),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          expect(
            (await db.observations.freezeNext({ ...input, limit: 2 }))
              ?.sourceInformationIds,
          ).toEqual([c]);
        });
        it("keeps delimiter-colliding addresses and Web conversations isolated", async () => {
          const left: SceneAddress = {
            platform: "a:b",
            adapterId: "c",
            destination: { kind: "group", groupId: "d" },
          };
          const right: SceneAddress = {
            platform: "a",
            adapterId: "b:c",
            destination: { kind: "group", groupId: "d" },
          };
          expect(sceneIdentity(left)).not.toBe(sceneIdentity(right));
          const a = await append(left);
          await append(right);
          expect(
            (await db.observations.freezeNext({ ...input, address: left }))
              ?.sourceInformationIds,
          ).toEqual([a]);
          const web: SceneAddress = {
            platform: "web",
            adapterId: "web",
            destination: { kind: "web" },
          };
          const anon = await append(web);
          await append({
            ...web,
            destination: { kind: "web", conversationId: randomUUID() },
          });
          expect(
            (await db.observations.freezeNext({ ...input, address: web }))
              ?.sourceInformationIds,
          ).toEqual([anon]);
        });
        it("does not import another sender or future evidence through a cutoff", async () => {
          const privateAddress: SceneAddress = {
            ...address,
            destination: { kind: "private", userId: "a" },
          };
          const a = await append(privateAddress, undefined, "a");
          await append(privateAddress, undefined, "b");
          const c = await append(privateAddress, undefined, "a");
          const query = { ...input, address: privateAddress, senderId: "a" };
          const first = (await db.observations.freezeNext({
            ...query,
            throughInformationId: a,
          }))!;
          expect(first.sourceInformationIds).toEqual([a]);
          await db.observations.finish(
            first.observationId,
            await result(first),
          );
          expect(
            await db.observations.freezeNext({
              ...query,
              throughInformationId: a,
            }),
          ).toBeUndefined();
          expect(
            (await db.observations.freezeNext(query))?.sourceInformationIds,
          ).toEqual([c]);
        });
        it("repeated schema preparation preserves frozen snapshots and failure does not alter successful progress", async () => {
          await append();
          const a = (await db.observations.freezeNext(input))!;
          await db.prepareSchema();
          expect(await db.observations.read(a.observationId)).toEqual(a);
          await db.observations.finish(a.observationId, await result(a));
          await db.observations.fail(a.observationId, "late-failure");
          expect((await db.observations.read(a.observationId))?.status).toBe(
            "completed",
          );
        });
        it("rejects mismatched result kinds, snapshot identities and unknown failures", async () => {
          await append();
          const page = (await db.observations.freezeNext(input))!;
          const memory = (await db.observations.freezeNext({
            ...input,
            consumerId: "memory",
          }))!;
          for (const invalid of [
            await result(memory),
            await result(page, page.sourceInformationIds, inbound),
          ]) {
            await expect(
              db.observations.finish(page.observationId, invalid),
            ).rejects.toBeInstanceOf(ObservationConflictError);
          }
          await expect(
            db.observations.progress({ ...input, resultKind: inbound }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          await expect(
            db.observations.fail("missing", "provider-error"),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
        });
        it("freezes exact context versions and refuses foreign evidence despite a shared reference", async () => {
          const a = await append();
          const context = await append();
          const foreign = await append({ ...address, adapterId: "other" });
          await expect(
            db.observations.freezeNext({
              ...input,
              contextInformationIds: [foreign],
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          // 一个引用本页来源的结果仍无同 scene 地址，不能因此被提升为可读上下文。
          const unscoped = await result({
            observationId: "not-yet-frozen",
            sourceInformationIds: [a],
            contextInformationIds: [],
          });
          await expect(
            db.observations.freezeNext({
              ...input,
              contextInformationIds: [unscoped],
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          const page = (await db.observations.freezeNext({
            ...input,
            throughInformationId: a,
            contextInformationIds: [context],
          }))!;
          const nextVersion = await append();
          expect(
            await db.observations.freezeNext({
              ...input,
              contextInformationIds: [nextVersion],
            }),
          ).toEqual(page);
          await expect(
            db.observations.finish(page.observationId, await result(page, [a])),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          await db.observations.finish(page.observationId, await result(page));
          expect(
            (await db.observations.read(page.observationId))
              ?.contextInformationIds,
          ).toEqual([context]);
        });
        it("rejects a cutoff outside the sender or source kind contract", async () => {
          const own = await append(address, undefined, "a");
          const other = await append(address, undefined, "b");
          await expect(
            db.observations.freezeNext({
              ...input,
              senderId: "a",
              throughInformationId: other,
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          const page = (await db.observations.freezeNext({
            ...input,
            throughInformationId: own,
          }))!;
          const proof = await result(page);
          await expect(
            db.observations.freezeNext({
              ...input,
              consumerId: "memory",
              throughInformationId: proof,
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
        });
        it("rolls back interrupted freezes and completion projections, then resumes a committed proof without a broadcast", async () => {
          const a = await append();
          await expect(
            failBeforeCommit(
              "INSERT INTO information_observations(",
            ).observations.freezeNext(input),
          ).rejects.toThrow("simulated-precommit-interruption");
          expect(await db.observations.progress(input)).toBeUndefined();
          const page = (await db.observations.freezeNext(input))!;
          const proof = await result(page);
          // 结果已落账但 finish 尚未执行：关闭连接不发送任何在线广播。
          await reconnect();
          expect(await db.observations.freezeNext(input)).toEqual(page);
          await expect(
            failBeforeCommit("SET status='completed'").observations.finish(
              page.observationId,
              proof,
            ),
          ).rejects.toThrow("simulated-precommit-interruption");
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
          expect((await db.observations.read(page.observationId))?.status).toBe(
            "frozen",
          );
          await reconnect();
          const completed = await db.observations.finish(
            page.observationId,
            proof,
          );
          await reconnect();
          expect(
            await db.observations.finish(page.observationId, proof),
          ).toEqual(completed);
          expect(await db.observations.freezeNext(input)).toBeUndefined();
          expect((await db.information.get(a))?.informationId).toBe(a);
        });
        it.skipIf(!postgres)(
          "does not freeze past an earlier source transaction that has not committed",
          async () => {
            let inserted = false;
            const release = Promise.withResolvers<void>();
            let freezing = false;
            const sql = db.sql;
            function intercepted(mode: "append" | "freeze") {
              return new KaguyaDatabase({
                query: sql.query.bind(sql),
                exec: sql.exec.bind(sql),
                close: async () => undefined,
                transaction: (run) =>
                  sql.transaction((tx) =>
                    run({
                      exec: tx.exec.bind(tx),
                      query: async <Row extends Record<string, unknown>>(
                        statement: string,
                        values?: readonly unknown[],
                      ) => {
                        if (
                          mode === "freeze" &&
                          statement.includes("pg_advisory_xact_lock")
                        )
                          freezing = true;
                        const result = await tx.query<Row>(statement, values);
                        if (
                          mode === "append" &&
                          statement.includes(
                            "INSERT INTO information_lifecycle",
                          )
                        ) {
                          inserted = true;
                          await release.promise;
                        }
                        return result;
                      },
                    }),
                  ),
              });
            }
            const writing = intercepted("append").information.append(
              freezeInformationAtom({
                informationId: informationIdSchema.parse("uncommitted-source"),
                kind: inbound,
                source: "test:observation",
                occurredAt: "2026-09-25T00:00:00.000Z",
                payload: { source: { ...address, senderId: "a" } },
                references: [],
              }),
              [],
            );
            // 立即观察拒绝，失败路径也释放源事务；barrier 只协调确定的 SQL 阶段，不按时长猜测。
            const writeOutcome = writing.then(
              () => undefined,
              (error) => error,
            );
            let freezeOutcome:
              Promise<ObservationSnapshot | undefined> | undefined;
            try {
              await vi.waitFor(() => expect(inserted).toBe(true), {
                timeout: 8000,
                interval: 20,
              });
              freezeOutcome =
                intercepted("freeze").observations.freezeNext(input);
              void freezeOutcome.catch(() => undefined);
              await vi.waitFor(() => expect(freezing).toBe(true), {
                timeout: 8000,
                interval: 20,
              });
              release.resolve();
              await writing;
              const page = (await freezeOutcome)!;
              expect(page.sourceInformationIds).toEqual(["uncommitted-source"]);
              await db.observations.finish(
                page.observationId,
                await result(page),
              );
              expect(await db.observations.freezeNext(input)).toBeUndefined();
            } finally {
              release.resolve();
              await Promise.allSettled([writeOutcome, freezeOutcome]);
            }
          },
        );
        it("serializes competing freezes and confirmations across connection-pool workers", async () => {
          const a = await append(),
            b = await append(),
            c = await append();
          const workers = await Promise.all(
            Array.from({ length: 12 }, () =>
              db.observations.freezeNext({ ...input, limit: 2 }),
            ),
          );
          const page = workers[0]!;
          expect(new Set(workers.map((s) => s?.observationId)).size).toBe(1);
          expect(page.sourceInformationIds).toEqual([a, b]);
          const proofs = [await result(page), await result(page)];
          const confirmations = await Promise.allSettled(
            proofs.map((proof) =>
              db.observations.finish(page.observationId, proof),
            ),
          );
          expect(
            confirmations.filter((r) => r.status === "fulfilled"),
          ).toHaveLength(1);
          expect(
            confirmations.filter((r) => r.status === "rejected"),
          ).toHaveLength(1);
          await reconnect();
          const next = (await db.observations.freezeNext({
            ...input,
            limit: 2,
          }))!;
          expect(next.sourceInformationIds).toEqual([c]);
          expect(next.hasMore).toBe(false);
          expect(next.afterPosition).toBe(page.throughPosition);
        });
      });
    },
  );
}
