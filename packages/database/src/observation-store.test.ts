/**
 * 功能概述：用 PGlite 和可选真实 PostgreSQL 事务验证观察快照、独立水位、来源隔离、失败恢复及并发唯一性。
 * fixture 每例独立数据库，写入与确认均 await 持久边界；并发 SQL 屏障使用 8 秒/20 毫秒有界轮询且 finally 释放事务。
 * 代码库关系：经公开 observations 与 information API 验证生产仓储；PostgreSQL 分支实际关闭并重连连接池，PGlite 只重建仓储对象。
 * 旧 #255 迁移用固定历史 DDL 与完成/开放种子验证首次升级，随后重连并继续消费。
 * 输入输出与副作用：合成群聊来源与确认原子，不调用模型/平台，afterEach 关闭测试数据库。
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  jsonObjectSchema,
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
        it("keeps successful later ranges behind a failed gap and reuses operation identities after restart", async () => {
          const a = await append(),
            b = await append();
          await db.observations.discover(input);
          const first = (await db.observations.freezeNext({
            ...input,
            operationKey: "first",
            limit: 1,
          }))!;
          const second = (await db.observations.freezeNext({
            ...input,
            operationKey: "second",
            limit: 1,
          }))!;
          expect(first.sourceInformationIds).toEqual([a]);
          expect(first.hasMore).toBe(true);
          await db.observations.fail(first.observationId, "controlled-failure");
          await db.observations.finish(
            second.observationId,
            await result(second),
          );
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
          expect(
            (await db.observations.pending(input)).map((p) => p.observationId),
          ).toEqual([first.observationId]);
          const c = await append(address, "2026-01-01T00:00:00.000Z");
          await reconnect();
          expect(
            (
              await db.observations.freezeNext({
                ...input,
                operationKey: "first",
              })
            )?.sourceInformationIds,
          ).toEqual([a]);
          await db.observations.finish(
            first.observationId,
            await result(first),
          );
          const progress = (await db.observations.progress(input))!;
          expect(progress.throughInformationId).toBe(b);
          expect(BigInt(progress.discoveredThroughPosition)).toBeGreaterThan(
            BigInt(progress.throughPosition),
          );
          const third = (await db.observations.freezeNext({
            ...input,
            operationKey: "third",
          }))!;
          expect(third.sourceInformationIds).toEqual([c]);
          expect(
            (await db.observations.discover({ ...input, consumerId: "memory" }))
              .throughPosition,
          ).toBe("0");
        });
        it("acknowledges each complete page independently and persists continuation over restart", async () => {
          const ids = [];
          for (let i = 0; i < 101; i++) ids.push(await append());
          const consumed: string[] = [];
          for (let i = 0; i < 4; i++) {
            const page = (await db.observations.freezeNext({
              ...input,
              operationKey: `page:${i}`,
              limit: 32,
            }))!;
            expect(page.complete).toBe(true);
            expect(page.hasMore).toBe(i < 3);
            consumed.push(...page.sourceInformationIds);
            await db.observations.finish(
              page.observationId,
              await result(page),
            );
            expect(
              (await db.observations.progress(input))?.throughInformationId,
            ).toBe(page.sourceInformationIds.at(-1));
            await reconnect();
          }
          expect(consumed).toEqual(ids);
          expect(new Set(consumed).size).toBe(101);
          expect(
            await db.observations.freezeNext({
              ...input,
              operationKey: "empty",
            }),
          ).toBeUndefined();
        });
        it("pins Memory content and claim identity, preserves an incomplete gap and replaces it explicitly", async () => {
          const a = await append(),
            b = await append();
          const run = await append();
          // 持久 turn 的真实 inputs、claim 和来源与 frame 一起作为证明；不相信调用方 manifest。
          const frame = async (
            revision: number,
            sourceIds: string[],
            evidenceIds = sourceIds,
          ) => {
            const id = informationIdSchema.parse(randomUUID());
            const turnId = informationIdSchema.parse(randomUUID());
            const atoms = await db.information.find({
              informationIds: sourceIds,
              limit: 1000,
            });
            const inputs = sourceIds.map((informationId) => {
              const atom = atoms.find(
                (a) => a.informationId === informationId,
              )!;
              return {
                informationId,
                text: atom.payload.text,
                source: atom.payload.source,
              };
            });
            const content = {
              background: { evidence: evidenceIds.map((id) => ({ id })) },
              memory: {
                fixed: [
                  {
                    id: "person",
                    content: `revision ${revision}`,
                    metadata: { revision },
                  },
                ],
              },
            };
            await db.information.append(
              freezeInformationAtom({
                informationId: turnId,
                kind: resultKind,
                source: "test:turn",
                occurredAt: "2026-09-25T00:00:01.000Z",
                payload: jsonObjectSchema.parse({
                  source: address,
                  claimInformationId: run,
                  inputs,
                  observedThroughInformationId: sourceIds.at(-1)!,
                }),
                references: [],
              }),
              [],
            );
            await db.information.append(
              freezeInformationAtom({
                informationId: id,
                kind: resultKind,
                source: "test:frame",
                occurredAt: "2026-09-25T00:00:01.000Z",
                payload: { turnInformationId: turnId, frame: content },
                references: [
                  { relation: "core:uses-context", informationId: turnId },
                ],
              }),
              [
                {
                  relation: "core:uses-context",
                  multiple: true,
                  required: true,
                },
              ],
            );
            return {
              version: 1 as const,
              runInformationId: run,
              frozenInformationId: id,
              sourceInformationIds: sourceIds,
              knowledgeCutoff: {
                informationId: id,
                memoryRevisions: [{ id: "person", revision }],
              },
              content,
            };
          };
          const original = await frame(1, [b]);
          const expanded = { ...original, sourceInformationIds: [a, b] };
          await expect(
            db.observations.freezeNext({
              ...input,
              operationKey: "forged-sources",
              throughInformationId: b,
              manifest: expanded,
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          const wrongRevision = {
            ...original,
            knowledgeCutoff: {
              ...original.knowledgeCutoff,
              memoryRevisions: [{ id: "person", revision: 99 }],
            },
          };
          await expect(
            db.observations.freezeNext({
              ...input,
              operationKey: "forged-memory",
              throughInformationId: b,
              manifest: wrongRevision,
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          const gap = (await db.observations.freezeNext({
            ...input,
            operationKey: "gap",
            throughInformationId: b,
            manifest: original,
          }))!;
          expect(gap.sourceInformationIds).toEqual([a]);
          expect(gap.complete).toBe(false);
          const page = (await db.observations.freezeNext({
            ...input,
            operationKey: "current",
            throughInformationId: b,
            manifest: original,
          }))!;
          expect(page.sourceInformationIds).toEqual([b]);
          const proof = await result(page, [
            b,
            run,
            original.frozenInformationId,
          ]);
          await db.observations.finish(page.observationId, proof);
          await expect(
            db.observations.finish(gap.observationId, await result(gap)),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
          const revised = await frame(2, [a, b]);
          await reconnect();
          expect(
            (
              await db.observations.freezeNext({
                ...input,
                operationKey: "current",
                manifest: revised,
              })
            )?.manifest,
          ).toEqual(original);
          await expect(
            db.observations.replace(
              gap.observationId,
              "forged-sources",
              expanded,
            ),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          await expect(
            db.observations.replace(gap.observationId, "forged-memory", {
              ...revised,
              knowledgeCutoff: {
                ...revised.knowledgeCutoff,
                memoryRevisions: [{ id: "person", revision: 99 }],
              },
            }),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          const missingBody = await frame(2, [a, b], [b]);
          await expect(
            db.observations.replace(
              gap.observationId,
              "missing-body",
              missingBody,
            ),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          const replacement = await db.observations.replace(
            gap.observationId,
            "read-gap",
            revised,
          );
          expect(replacement.sourceInformationIds).toEqual([a]);
          expect(replacement.complete).toBe(true);
          await expect(
            db.observations.finish(gap.observationId, await result(gap)),
          ).rejects.toBeInstanceOf(ObservationConflictError);
          await db.observations.finish(
            replacement.observationId,
            await result(replacement, [a, run, revised.frozenInformationId]),
          );
          expect(
            (await db.observations.progress(input))?.throughInformationId,
          ).toBe(b);
          expect(
            (await db.observations.read(gap.observationId))
              ?.replacementObservationId,
          ).toBe(replacement.observationId);
          await db.prepareSchema();
          expect(
            (await db.observations.read(page.observationId))?.manifest,
          ).toEqual(original);
        });
        it("persists defer without confirming input and survives duplicate worker operations", async () => {
          const a = await append();
          const pages = await Promise.all(
            Array.from({ length: 6 }, () =>
              db.observations.freezeNext({ ...input, operationKey: "same" }),
            ),
          );
          const page = pages[0]!;
          expect(new Set(pages.map((p) => p!.observationId)).size).toBe(1);
          const schedule = await result(page);
          await db.observations.defer(
            page.observationId,
            "2026-10-24T08:00:00.000Z",
            schedule,
          );
          await reconnect();
          expect((await db.observations.pending(input))[0]?.deferredUntil).toBe(
            "2026-10-24T08:00:00.000Z",
          );
          expect((await db.observations.progress(input))?.throughPosition).toBe(
            "0",
          );
          await db.observations.finish(page.observationId, await result(page));
          expect(
            (await db.observations.progress(input))?.throughInformationId,
          ).toBe(a);
        });
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
        it("migrates populated PR255 tables without replacing old facts or consumer progress", async () => {
          const a = await append(),
            b = await append(),
            c = await append();
          const positions = await db.sql.query<{
            information_id: string;
            position: string;
          }>(
            `SELECT information_id,position::text FROM information_lifecycle WHERE information_id=ANY($1::text[])`,
            [[a, b, c]],
          );
          const position = (id: string) =>
            positions.rows.find((r) => r.information_id === id)!.position;
          const completedId = randomUUID(),
            openId = randomUUID();
          const proof = await result({
            observationId: completedId,
            sourceInformationIds: [a],
            contextInformationIds: [],
          });
          const facts = await db.information.find({
            informationIds: [a, b, c, proof],
            registrationOrder: true,
            order: "asc",
            limit: 10,
          });
          // 仅重建本例隔离库的附加观察表；DDL 固定来自 #255 ac292582，不调用新迁移来伪造旧状态。
          await db.sql.exec(
            `DROP TABLE information_observation_attempts,information_observations,information_observation_progress,information_scenes;`,
          );
          await db.sql.exec(`
      CREATE TABLE IF NOT EXISTS information_scenes (
        scene_id text PRIMARY KEY, address jsonb NOT NULL,
        legacy_scope_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      );
      CREATE TABLE IF NOT EXISTS information_observation_progress (
        stream_id text PRIMARY KEY, scene_id text NOT NULL REFERENCES information_scenes(scene_id),
        consumer_id text NOT NULL, policy_version text NOT NULL, contract jsonb NOT NULL,
        through_position bigint NOT NULL DEFAULT 0, latest_observation_id text
      );
      CREATE TABLE IF NOT EXISTS information_observations (
        observation_id text PRIMARY KEY,
        stream_id text NOT NULL REFERENCES information_observation_progress(stream_id),
        after_position bigint NOT NULL, through_position bigint NOT NULL,
        source_ids jsonb NOT NULL, context_ids jsonb NOT NULL, has_more boolean NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds',clock_timestamp()),
        status text NOT NULL DEFAULT 'frozen' CHECK(status IN ('frozen','completed','failed')),
        result_information_id text REFERENCES information_atoms(information_id), error_code text,
        CHECK(through_position > after_position),
        UNIQUE(stream_id, after_position)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS information_observations_open_idx
        ON information_observations(stream_id) WHERE status <> 'completed';
      CREATE INDEX IF NOT EXISTS information_observations_scene_idx
        ON information_observations(stream_id, through_position DESC);
    `);
          const sceneId = sceneIdentity(address);
          const streamId = JSON.stringify([
            sceneId,
            input.consumerId,
            input.policyVersion,
            null,
          ]);
          await db.sql.query(
            `INSERT INTO information_scenes(scene_id,address,legacy_scope_key) VALUES($1,$2::jsonb,$3)`,
            [sceneId, JSON.stringify(address), "qq:test:group:g"],
          );
          await db.sql.query(
            `INSERT INTO information_observation_progress(stream_id,scene_id,consumer_id,policy_version,contract,through_position,latest_observation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6::bigint,$7)`,
            [
              streamId,
              sceneId,
              input.consumerId,
              input.policyVersion,
              JSON.stringify(input),
              position(a),
              completedId,
            ],
          );
          await db.sql.query(
            `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,status,result_information_id,recorded_at) VALUES
            ($1,$2,0,$3::bigint,$4::jsonb,'[]',true,'completed',$5,'2026-10-01T00:00:00Z'),
            ($6,$2,$3::bigint,$7::bigint,$8::jsonb,'[]',true,'frozen',NULL,'2026-10-01T00:00:01Z')`,
            [
              completedId,
              streamId,
              position(a),
              JSON.stringify([a]),
              proof,
              openId,
              position(b),
              JSON.stringify([b]),
            ],
          );
          const oldRows = (
            await db.sql.query(
              `SELECT observation_id,stream_id,after_position::text,through_position::text,source_ids,context_ids,has_more,status,result_information_id,recorded_at::text,error_code FROM information_observations ORDER BY after_position`,
            )
          ).rows;
          await db.prepareSchema();
          expect(
            (
              await db.sql.query(
                `SELECT observation_id,stream_id,after_position::text,through_position::text,source_ids,context_ids,has_more,status,result_information_id,recorded_at::text,error_code FROM information_observations ORDER BY after_position`,
              )
            ).rows,
          ).toEqual(oldRows);
          expect(await db.observations.progress(input)).toMatchObject({
            throughPosition: position(a),
            throughInformationId: a,
            allocatedThroughPosition: position(b),
            discoveredThroughPosition: position(b),
            latestObservationId: completedId,
            policyVersion: input.policyVersion,
            revision: 0,
          });
          expect(await db.observations.read(completedId)).toMatchObject({
            status: "completed",
            manifest: null,
            operationKey: null,
            resultInformationId: proof,
            contract: input,
            sourceInformationIds: [a],
          });
          expect(await db.observations.read(openId)).toMatchObject({
            status: "frozen",
            manifest: null,
            operationKey: null,
            sourceInformationIds: [b],
            contract: input,
          });
          expect(
            await db.information.find({
              informationIds: [a, b, c, proof],
              registrationOrder: true,
              order: "asc",
              limit: 10,
            }),
          ).toEqual(facts);
          await reconnect();
          const open = (await db.observations.freezeNext(input))!;
          expect(open.observationId).toBe(openId);
          await db.observations.finish(openId, await result(open));
          expect(
            (await db.observations.progress(input))?.throughInformationId,
          ).toBe(b);
          const next = (await db.observations.freezeNext({
            ...input,
            operationKey: "after-upgrade",
          }))!;
          expect(next.sourceInformationIds).toEqual([c]);
          await db.observations.finish(next.observationId, await result(next));
          await db.prepareSchema();
          expect(
            (await db.observations.progress(input))?.throughInformationId,
          ).toBe(c);
          expect(
            (await db.observations.read(completedId))?.resultInformationId,
          ).toBe(proof);
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
        if (postgres)
          it("does not freeze past an earlier source transaction that has not committed", async () => {
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
          });
        if (postgres)
          it("serializes supersede against a completion already holding the progress lock", async () => {
            await append();
            const original = (await db.observations.freezeNext({
              ...input,
              operationKey: "original",
            }))!;
            const replacement = randomUUID();
            // Stage a competing replacement row to exercise the public supersede port independently.
            await db.sql.query(
              `INSERT INTO information_observations(observation_id,stream_id,after_position,through_position,source_ids,context_ids,has_more,operation_key)
            SELECT $2,stream_id,after_position,through_position,source_ids,context_ids,has_more,'staged-replacement' FROM information_observations WHERE observation_id=$1`,
              [original.observationId, replacement],
            );
            const proof = await result(original);
            let release!: () => void;
            const barrier = new Promise<void>((resolve) => {
              release = resolve;
            });
            let read = false;
            const wrapped: SqlDatabase = {
              query: db.sql.query.bind(db.sql),
              exec: db.sql.exec.bind(db.sql),
              close: async () => {},
              transaction: (run) =>
                db.sql.transaction((tx) =>
                  run({
                    exec: tx.exec.bind(tx),
                    query: async <Row extends Record<string, unknown>>(
                      sql: string,
                      values?: readonly unknown[],
                    ) => {
                      const value = await tx.query<Row>(sql, values);
                      if (sql.startsWith("SELECT o.observation_id") && !read) {
                        read = true;
                        await barrier;
                      }
                      return value;
                    },
                  }),
                ),
            };
            const finish = new KaguyaDatabase(wrapped).observations.finish(
              original.observationId,
              proof,
            );
            let supersede: Promise<unknown> | undefined;
            let settled = false;
            try {
              await vi.waitFor(() => expect(read).toBe(true), {
                timeout: 8000,
                interval: 20,
              });
              supersede = db.observations
                .supersede(original.observationId, replacement)
                .then(
                  (value) => {
                    settled = true;
                    return value;
                  },
                  (error) => {
                    settled = true;
                    throw error;
                  },
                );
              // Observe the actual SQL wait, or an incorrect early completion, before releasing the winner.
              void supersede.catch(() => {});
              await vi.waitFor(
                async () => {
                  const waiting = await db.sql.query(
                    `SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%information_observation_progress%FOR UPDATE%'`,
                  );
                  expect(settled || waiting.rows.length > 0).toBe(true);
                },
                { timeout: 8000, interval: 20 },
              );
            } finally {
              release();
              await Promise.allSettled([finish, supersede]);
            }
            const outcomes = await Promise.allSettled([finish, supersede!]);
            expect(outcomes.map((o) => o.status)).toEqual([
              "fulfilled",
              "rejected",
            ]);
            expect(
              (await db.observations.read(original.observationId))
                ?.replacementObservationId,
            ).toBeNull();
            expect(
              (await db.observations.progress(input))?.throughPosition,
            ).toBe(original.throughPosition);
          });
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
