/**
 * 功能概述：此测试模块把 information ledger 的持久化行为定义为可由多个数据库后端注册的契约，防止 PGlite 与真实 PostgreSQL 的语义漂移。
 * 主要职责：`defineInformationLedgerContract` 接收显示名称和 `KaguyaDatabase` factory，注册 kind 的新增登记与历史缺失拒绝、原子追加、引用校验、读取排序与 outbox 投影的共享行为测试。
 * 代码库关系：`information-repository.test.ts` 用 PGlite factory 注册；`postgres-information-ledger.test.ts` 用 schema 隔离的 PostgreSQL factory 注册；仓储、迁移和 runner 是被测的生产边界。
 * 输入输出与副作用：每个用例迁移独立数据库，并在 `afterEach` 关闭它；断言只通过公开数据库 API 与原始 SQL 观察持久化及事务结果。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  freezeInformationAtom,
  informationIdSchema,
  type JsonObject,
  z,
} from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import {
  InformationIdConflictError,
  InformationLogProjectionRunner,
  InformationStoreError,
  InvalidInformationReferenceError,
  KaguyaDatabase,
} from "./index.js";

export interface InformationLedgerContractOptions {
  readonly name: string;
  readonly createDatabase: () => Promise<KaguyaDatabase>;
}

const TEST_TIMEOUT = 15_000;

const contextKind = defineInformationKind({
  kind: "core.runtime.context",
  payloadSchema: z.object({ name: z.string() }).strict(),
  references: {},
  log: { enabled: false },
});

const inboundKind = defineInformationKind({
  kind: "core.message.inbound.text",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:context": {
      required: true,
      multiple: false,
      targetKinds: [contextKind.kind],
    },
  },
  log: { enabled: false },
});

const replyKind = defineInformationKind({
  kind: "core.message.assistant.text",
  payloadSchema: z.object({ text: z.string() }).strict(),
  references: {
    "core:caused-by": {
      required: true,
      multiple: false,
      targetKinds: [inboundKind.kind],
    },
  },
  log: { enabled: false },
});

const multiReferenceKind = defineInformationKind({
  kind: "core.runtime.context.bundle",
  payloadSchema: z.object({ name: z.string() }).strict(),
  references: {
    "core:contexts": {
      required: true,
      multiple: true,
      targetKinds: [contextKind.kind],
    },
  },
  log: { enabled: false },
});

const plainKind = defineInformationKind({
  kind: "core.runtime.snapshot",
  payloadSchema: z
    .object({
      nested: z.object({ values: z.array(z.string()) }).strict(),
    })
    .strict(),
  references: {},
  log: { enabled: false },
});

function createAtom(
  informationId: string,
  kind: string,
  occurredAt: string,
  payload: JsonObject,
  references: readonly { relation: string; informationId: string }[],
  source = "module:test",
) {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse(informationId),
    kind,
    occurredAt,
    source,
    payload,
    references: [...references],
  });
}

export function defineInformationLedgerContract(
  options: InformationLedgerContractOptions,
): void {
  describe(options.name, () => {
    let database: KaguyaDatabase | undefined;

    async function createMigratedDatabase(): Promise<KaguyaDatabase> {
      database = await options.createDatabase();
      await database.migrate();
      return database;
    }

    afterEach(async () => {
      await database?.close();
      database = undefined;
    });

    it(
      "registers added kinds but rejects removing persisted kinds",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]);
        await expect(
          database.information.synchronizeKinds([contextKind.kind]),
        ).rejects.toBeInstanceOf(InformationStoreError);
      },
      TEST_TIMEOUT,
    );

    it(
      "round-trips payloads through JSONB",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([plainKind.kind]);
        const atom = createAtom(
          "atom-jsonb",
          plainKind.kind,
          "2026-09-01T00:00:00.000Z",
          { nested: { values: ["moon", "light"] } },
          [],
        );
        await database.information.append(atom, []);
        const result = await database.sql.query<{ payload: unknown }>(
          "SELECT payload FROM information_atoms WHERE information_id = $1",
          [atom.informationId],
        );
        expect(result.rows[0]?.payload).toEqual(atom.payload);
      },
      TEST_TIMEOUT,
    );

    it(
      "finds atoms by kind and source in chronological order",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
          replyKind.kind,
        ]);

        const inbound = createAtom(
          "atom-find-inbound",
          inboundKind.kind,
          "2026-09-03T23:59:00.000Z",
          { text: "input" },
          [],
        );
        await database.information.append(inbound, []);

        const causedBy = [
          {
            relation: "core:caused-by",
            informationId: inbound.informationId,
          },
        ];
        const expectation = [
          {
            relation: "core:caused-by",
            targetKinds: [inboundKind.kind],
            required: true,
            multiple: false,
          },
        ];
        await database.information.append(
          createAtom(
            "atom-other-kind",
            contextKind.kind,
            "2026-09-04T00:00:00.000Z",
            { name: "other" },
            [],
            "module:reply",
          ),
          [],
        );
        await database.information.append(
          createAtom(
            "atom-reply-later",
            replyKind.kind,
            "2026-09-04T00:00:01.000Z",
            { text: "later" },
            causedBy,
            "module:reply",
          ),
          expectation,
        );
        await database.information.append(
          createAtom(
            "atom-reply-earlier",
            replyKind.kind,
            "2026-09-04T08:00:00+08:00",
            { text: "earlier" },
            causedBy,
            "module:reply",
          ),
          expectation,
        );
        await database.information.append(
          createAtom(
            "atom-other-source",
            replyKind.kind,
            "2026-09-03T23:59:59.000Z",
            { text: "other source" },
            causedBy,
            "module:other",
          ),
          expectation,
        );

        const found = await database.information.find({
          kinds: [replyKind.kind],
          sources: ["module:reply"],
          limit: 10,
        });

        expect(found.map(({ informationId }) => informationId)).toEqual([
          "atom-reply-earlier",
          "atom-reply-later",
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "uses a half-open occurredAt interval",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);
        for (const [informationId, occurredAt] of [
          ["atom-before-window", "2026-09-04T00:00:00.999Z"],
          ["atom-at-lower-bound", "2026-09-04T00:00:01.000Z"],
          ["atom-inside-window", "2026-09-04T00:00:02.000Z"],
          ["atom-at-upper-bound", "2026-09-04T00:00:03.000Z"],
        ] as const) {
          await database.information.append(
            createAtom(
              informationId,
              contextKind.kind,
              occurredAt,
              { name: informationId },
              [],
            ),
            [],
          );
        }

        const found = await database.information.find({
          occurredAfter: "2026-09-04T00:00:01.000Z",
          occurredBefore: "2026-09-04T00:00:03.000Z",
          limit: 10,
        });

        expect(found.map(({ informationId }) => informationId)).toEqual([
          "atom-at-lower-bound",
          "atom-inside-window",
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "applies limit after deterministic ordering",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          inboundKind.kind,
          replyKind.kind,
        ]);
        const inbound = createAtom(
          "atom-limit-inbound",
          inboundKind.kind,
          "2026-09-03T23:59:00.000Z",
          { text: "input" },
          [],
        );
        await database.information.append(inbound, []);
        const expectation = [
          {
            relation: "core:caused-by",
            targetKinds: [inboundKind.kind],
            required: true,
            multiple: false,
          },
        ];
        for (const [informationId, occurredAt] of [
          ["atom-reply-later", "2026-09-04T00:00:02.000Z"],
          ["atom-reply-earlier", "2026-09-04T00:00:01.000Z"],
        ] as const) {
          await database.information.append(
            createAtom(
              informationId,
              replyKind.kind,
              occurredAt,
              { text: informationId },
              [
                {
                  relation: "core:caused-by",
                  informationId: inbound.informationId,
                },
              ],
            ),
            expectation,
          );
        }

        const found = await database.information.find({
          kinds: [replyKind.kind],
          limit: 1,
        });

        expect(found.map(({ informationId }) => informationId)).toEqual([
          "atom-reply-earlier",
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "rolls back an atom when a target reference is missing",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]);

        const inboundAtom = createAtom(
          "atom-missing-target",
          inboundKind.kind,
          "2026-09-01T00:00:00.000Z",
          { text: "hello" },
          [
            {
              relation: "core:context",
              informationId: "missing-context",
            },
          ],
        );

        await expect(
          database.information.append(inboundAtom, [
            {
              relation: "core:context",
              targetKinds: [contextKind.kind],
              required: true,
              multiple: false,
            },
          ]),
        ).rejects.toBeInstanceOf(InvalidInformationReferenceError);

        expect(
          await database.information.get(inboundAtom.informationId),
        ).toBeUndefined();
        const outbox = await database.sql.query<{ count: string }>(
          "SELECT COUNT(*)::text AS count FROM information_log_outbox",
        );
        expect(outbox.rows[0]?.count).toBe("0");
      },
      TEST_TIMEOUT,
    );

    it(
      "keeps reference order when storing and reading atoms",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          multiReferenceKind.kind,
        ]);

        const firstContext = createAtom(
          "atom-reference-z",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "z" },
          [],
        );
        const secondContext = createAtom(
          "atom-reference-a",
          contextKind.kind,
          "2026-09-01T00:00:01.000Z",
          { name: "a" },
          [],
        );
        await database.information.append(firstContext, []);
        await database.information.append(secondContext, []);

        const inboundAtom = createAtom(
          "atom-references",
          multiReferenceKind.kind,
          "2026-09-01T00:02:00.000Z",
          { name: "bundle" },
          [
            {
              relation: "core:contexts",
              informationId: firstContext.informationId,
            },
            {
              relation: "core:contexts",
              informationId: secondContext.informationId,
            },
          ],
        );

        await database.information.append(inboundAtom, [
          {
            relation: "core:contexts",
            targetKinds: [contextKind.kind],
            required: true,
            multiple: true,
          },
        ]);

        expect(
          (await database.information.get(inboundAtom.informationId))
            ?.references,
        ).toEqual([
          {
            relation: "core:contexts",
            informationId: firstContext.informationId,
          },
          {
            relation: "core:contexts",
            informationId: secondContext.informationId,
          },
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "rejects a target kind mismatch",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]);

        const wrongTarget = createAtom(
          "atom-wrong-target",
          inboundKind.kind,
          "2026-09-01T00:00:00.000Z",
          { text: "hello" },
          [
            {
              relation: "core:context",
              informationId: "atom-wrong-context",
            },
          ],
        );

        await database.information.append(
          createAtom(
            "atom-wrong-context",
            inboundKind.kind,
            "2026-09-01T00:00:00.000Z",
            { text: "not-context" },
            [],
          ),
          [],
        );

        await expect(
          database.information.append(wrongTarget, [
            {
              relation: "core:context",
              targetKinds: [contextKind.kind],
              required: true,
              multiple: false,
            },
          ]),
        ).rejects.toBeInstanceOf(InvalidInformationReferenceError);

        expect(
          await database.information.get(wrongTarget.informationId),
        ).toBeUndefined();
        expect(
          (
            await database.sql.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM information_log_outbox",
            )
          ).rows[0]?.count,
        ).toBe("0");
      },
      TEST_TIMEOUT,
    );

    it(
      "rejects duplicate information ids",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);

        const atom = createAtom(
          "atom-duplicate",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "context" },
          [],
        );

        await database.information.append(atom, []);
        await expect(
          database.information.append(atom, []),
        ).rejects.toBeInstanceOf(InformationIdConflictError);
      },
      TEST_TIMEOUT,
    );

    it(
      "rolls back an atom with an undeclared relation",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]);
        const atom = createAtom(
          "atom-undeclared-relation",
          inboundKind.kind,
          "2026-09-01T00:00:00.000Z",
          { text: "hello" },
          [{ relation: "core:unknown", informationId: "missing-context" }],
        );
        await expect(
          database.information.append(atom, []),
        ).rejects.toMatchObject({
          reason: "undeclared",
        });
        expect(
          await database.information.get(atom.informationId),
        ).toBeUndefined();
        expect(
          (
            await database.sql.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM information_log_outbox",
            )
          ).rows[0]?.count,
        ).toBe("0");
      },
      TEST_TIMEOUT,
    );

    it(
      "rolls back an atom with a repeated single-value relation",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]);
        const context = createAtom(
          "atom-duplicate-relation-context",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "context" },
          [],
        );
        await database.information.append(context, []);
        const atom = createAtom(
          "atom-duplicate-relation",
          inboundKind.kind,
          "2026-09-01T00:01:00.000Z",
          { text: "hello" },
          [
            { relation: "core:context", informationId: context.informationId },
            { relation: "core:context", informationId: context.informationId },
          ],
        );
        const expectations = [
          {
            relation: "core:context",
            targetKinds: [contextKind.kind],
            required: true,
            multiple: false,
          },
        ];
        await expect(
          database.information.append(atom, expectations),
        ).rejects.toMatchObject({
          reason: "multiple",
        });
        expect(
          await database.information.get(atom.informationId),
        ).toBeUndefined();
        expect(
          (
            await database.sql.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM information_log_outbox",
            )
          ).rows[0]?.count,
        ).toBe("0");
      },
      TEST_TIMEOUT,
    );

    it(
      "rolls back an atom missing a required relation",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
        ]);
        const atom = createAtom(
          "atom-missing-required-relation",
          inboundKind.kind,
          "2026-09-01T00:00:00.000Z",
          { text: "hello" },
          [],
        );
        const expectations = [
          {
            relation: "core:context",
            targetKinds: [contextKind.kind],
            required: true,
            multiple: false,
          },
        ];
        await expect(
          database.information.append(atom, expectations),
        ).rejects.toMatchObject({
          reason: "required",
        });
        expect(
          await database.information.get(atom.informationId),
        ).toBeUndefined();
        expect(
          (
            await database.sql.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM information_log_outbox",
            )
          ).rows[0]?.count,
        ).toBe("0");
      },
      TEST_TIMEOUT,
    );

    it(
      "orders reverse-reference reads by atom occurrence and id",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([
          contextKind.kind,
          inboundKind.kind,
          replyKind.kind,
        ]);

        const contextAtom = createAtom(
          "atom-root",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "context" },
          [],
        );
        await database.information.append(contextAtom, []);

        const laterReply = createAtom(
          "atom-reply-b",
          replyKind.kind,
          "2026-09-01T00:02:00.000Z",
          { text: "b" },
          [
            {
              relation: "core:caused-by",
              informationId: contextAtom.informationId,
            },
          ],
        );
        const earlierReply = createAtom(
          "atom-reply-a",
          replyKind.kind,
          "2026-09-01T00:01:00.000Z",
          { text: "a" },
          [
            {
              relation: "core:caused-by",
              informationId: contextAtom.informationId,
            },
          ],
        );

        await database.information.append(laterReply, [
          {
            relation: "core:caused-by",
            targetKinds: [contextKind.kind],
            required: true,
            multiple: false,
          },
        ]);
        await database.information.append(earlierReply, [
          {
            relation: "core:caused-by",
            targetKinds: [contextKind.kind],
            required: true,
            multiple: false,
          },
        ]);

        const replies = await database.information.query({
          relation: "core:caused-by",
          informationId: contextAtom.informationId,
        });

        expect(replies.map((atom) => atom.informationId)).toEqual([
          earlierReply.informationId,
          laterReply.informationId,
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "rejects two concurrent appends with the same id",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);

        const atom = createAtom(
          "atom-race",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "context" },
          [],
        );

        const results = await Promise.allSettled([
          database.information.append(atom, []),
          database.information.append(atom, []),
        ]);

        expect(
          results.filter((result) => result.status === "fulfilled"),
        ).toHaveLength(1);
        expect(
          results.filter((result) => result.status === "rejected"),
        ).toHaveLength(1);
        expect(
          results.find(
            (result): result is PromiseRejectedResult =>
              result.status === "rejected",
          )?.reason,
        ).toBeInstanceOf(InformationIdConflictError);
      },
      TEST_TIMEOUT,
    );

    it(
      "keeps the atom and its enabled log projection job in one transaction",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);

        const atom = createAtom(
          "atom-outbox",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "context" },
          [],
        );
        await database.information.append(atom, [], {
          enqueueLogProjection: true,
        });

        expect(
          await database.information.get(atom.informationId),
        ).toMatchObject({
          informationId: atom.informationId,
        });
        expect(
          await database.information.listPendingLogProjections(10),
        ).toEqual([{ informationId: atom.informationId, attemptCount: 0 }]);
      },
      TEST_TIMEOUT,
    );

    it(
      "rolls back an atom when its outbox insert fails",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);
        await database.sql.exec(`
        CREATE OR REPLACE FUNCTION fail_information_log_outbox_insert()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $$
        BEGIN
          RAISE EXCEPTION 'forced outbox failure';
        END;
        $$;

        CREATE TRIGGER information_log_outbox_force_failure
          BEFORE INSERT ON information_log_outbox
          FOR EACH ROW
          EXECUTE FUNCTION fail_information_log_outbox_insert();
      `);
        const atom = createAtom(
          "atom-outbox-rollback",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "rollback" },
          [],
        );

        await expect(
          database.information.append(atom, [], { enqueueLogProjection: true }),
        ).rejects.toBeInstanceOf(InformationStoreError);
        expect(
          await database.information.get(atom.informationId),
        ).toBeUndefined();
        expect(
          (
            await database.sql.query<{ count: string }>(
              "SELECT COUNT(*)::text AS count FROM information_log_outbox",
            )
          ).rows[0]?.count,
        ).toBe("0");
      },
      TEST_TIMEOUT,
    );

    it(
      "returns only existing atoms from getMany in caller order",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);

        const first = createAtom(
          "atom-many-a",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "a" },
          [],
        );
        const second = createAtom(
          "atom-many-b",
          contextKind.kind,
          "2026-09-01T00:01:00.000Z",
          { name: "b" },
          [],
        );
        await database.information.append(first, []);
        await database.information.append(second, []);

        const results = await database.information.getMany([
          second.informationId,
          informationIdSchema.parse("atom-missing"),
          first.informationId,
        ]);
        expect(results.map((atom) => atom.informationId)).toEqual([
          second.informationId,
          first.informationId,
        ]);
      },
      TEST_TIMEOUT,
    );

    it(
      "retries a failed log projection after the runner is recreated",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);

        const atom = createAtom(
          "atom-retry-log",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "retry" },
          [],
        );
        await database.information.append(atom, [], {
          enqueueLogProjection: true,
        });

        const failures: string[] = [];
        const failingRunner = new InformationLogProjectionRunner({
          repository: database.information,
          sink: async () => {
            throw new Error("console is unavailable");
          },
          reportFailure: (failure) => {
            failures.push(failure.errorType);
          },
        });
        await expect(failingRunner.projectPending()).resolves.toBeUndefined();
        expect(
          await database.information.get(atom.informationId),
        ).toBeDefined();
        expect(
          await database.information.listPendingLogProjections(10),
        ).toEqual([{ informationId: atom.informationId, attemptCount: 1 }]);
        expect(failures).toEqual(["sink_failed"]);

        const projected: string[] = [];
        const recoveredRunner = new InformationLogProjectionRunner({
          repository: database.information,
          sink: async (projectedAtom) => {
            projected.push(projectedAtom.informationId);
          },
        });
        await recoveredRunner.projectPending();
        expect(projected).toEqual([atom.informationId]);
        expect(
          await database.information.listPendingLogProjections(10),
        ).toEqual([]);
        const delivered = await database.sql.query<{
          projected_at: string | null;
        }>(
          "SELECT projected_at FROM information_log_outbox WHERE information_id = $1",
          [atom.informationId],
        );
        expect(delivered.rows[0]?.projected_at).toBeTruthy();
      },
      TEST_TIMEOUT,
    );

    it(
      "coalesces concurrent projection calls so one pending atom reaches the sink once",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);
        const atom = createAtom(
          "atom-concurrent-log",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "concurrent" },
          [],
        );
        await database.information.append(atom, [], {
          enqueueLogProjection: true,
        });
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const projected: string[] = [];
        const runner = new InformationLogProjectionRunner({
          repository: database.information,
          sink: async (projectedAtom) => {
            projected.push(projectedAtom.informationId);
            await gate;
          },
        });

        const first = runner.projectPending();
        const second = runner.projectPending();
        await vi.waitFor(() => expect(projected).toHaveLength(1));
        release();
        await Promise.all([first, second]);

        expect(projected).toEqual([atom.informationId]);
      },
      TEST_TIMEOUT,
    );

    it(
      "drains every successful pending batch until the outbox is empty",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);
        for (const id of ["atom-drain-a", "atom-drain-b", "atom-drain-c"]) {
          await database.information.append(
            createAtom(
              id,
              contextKind.kind,
              "2026-09-01T00:00:00.000Z",
              { name: id },
              [],
            ),
            [],
            { enqueueLogProjection: true },
          );
        }
        const projected: string[] = [];
        const runner = new InformationLogProjectionRunner({
          repository: database.information,
          batchSize: 2,
          sink: async (atom) => {
            projected.push(atom.informationId);
          },
        });

        await (runner as any).drainPending();

        expect(projected).toEqual([
          "atom-drain-a",
          "atom-drain-b",
          "atom-drain-c",
        ]);
        expect(
          await database.information.listPendingLogProjections(10),
        ).toEqual([]);
      },
      TEST_TIMEOUT,
    );

    it(
      "checks for a real empty batch when a concurrent short batch enqueues more work",
      async () => {
        const database = await createMigratedDatabase();
        await database.information.synchronizeKinds([contextKind.kind]);
        const first = createAtom(
          "atom-short-batch-first",
          contextKind.kind,
          "2026-09-01T00:00:00.000Z",
          { name: "first" },
          [],
        );
        const second = createAtom(
          "atom-short-batch-second",
          contextKind.kind,
          "2026-09-01T00:01:00.000Z",
          { name: "second" },
          [],
        );
        await database.information.append(first, [], {
          enqueueLogProjection: true,
        });
        const projected: string[] = [];
        const runner = new InformationLogProjectionRunner({
          repository: database.information,
          batchSize: 100,
          sink: async (atom) => {
            projected.push(atom.informationId);
            if (atom.informationId === first.informationId) {
              await database.information.append(second, [], {
                enqueueLogProjection: true,
              });
            }
          },
        });

        await Promise.all([runner.drainPending(), runner.drainPending()]);

        expect(projected).toEqual([first.informationId, second.informationId]);
        expect(
          await database.information.listPendingLogProjections(10),
        ).toEqual([]);
      },
      TEST_TIMEOUT,
    );
  });
}
