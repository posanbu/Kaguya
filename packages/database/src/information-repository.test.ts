/**
 * 功能概述：本测试覆盖信息原子仓储的 append、查询、引用约束与冲突语义，
 * 先以真实 PostgreSQL 行为锁定 append-only 关系图的读写契约，再交由实现补齐。
 * 主要职责：验证缺失/错误目标、重复 ID、并发写入、引用顺序、结构化筛选顺序、
 * 反向查询顺序与日志 outbox 生命周期、runner 并发去重、短批次并发入队与以真实
 * 空批次为终点的排空，所有读取只使用最终 `get/getMany/find/query` API。
 * 代码库关系：测试只面向 `createTestingDatabase()` 返回值和 `information`
 * 仓储接口，验证引用顺序、目标 kind 校验、冲突错误与反向引用查询顺序。
 * 输入输出与副作用：每个用例创建、迁移并关闭独立 PGlite 数据库；断言直接观察真实
 * SQL 事务结果，不连接外部 PostgreSQL 服务。
 */
import { describe, expect, it, vi } from "vitest";

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
  InvalidInformationReferenceError,
} from "./index.js";
import { createTestingDatabase } from "./testing.js";

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

function createAtom(
  informationId: string,
  kind: string,
  occurredAt: string,
  payload: JsonObject,
  references: readonly {
    relation: string;
    informationId: string;
  }[],
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

describe("information repository", () => {
  it(
    "finds atoms by kind and source in chronological order",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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
      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "uses a half-open occurredAt interval",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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
      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "applies limit after deterministic ordering",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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
      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "rolls back an atom when a target reference is missing",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps reference order when storing and reading atoms",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
      await database.information.synchronizeKinds([
        contextKind.kind,
        inboundKind.kind,
      ]);

      const contextAtom = createAtom(
        "atom-context",
        contextKind.kind,
        "2026-09-01T00:00:00.000Z",
        { name: "context" },
        [],
      );
      await database.information.append(contextAtom, []);

      const inboundAtom = createAtom(
        "atom-references",
        inboundKind.kind,
        "2026-09-01T00:01:00.000Z",
        { text: "hello" },
        [
          {
            relation: "core:context",
            informationId: contextAtom.informationId,
          },
        ],
      );

      await database.information.append(inboundAtom, [
        {
          relation: "core:context",
          targetKinds: [contextKind.kind],
          required: true,
          multiple: false,
        },
      ]);

      expect(
        (await database.information.get(inboundAtom.informationId))?.references,
      ).toEqual([
        {
          relation: "core:context",
          informationId: contextAtom.informationId,
        },
      ]);

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects a target kind mismatch",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects duplicate information ids",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "orders reverse-reference reads by atom occurrence and id",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "rejects two concurrent appends with the same id",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps the atom and its enabled log projection job in one transaction",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      expect(await database.information.get(atom.informationId)).toMatchObject({
        informationId: atom.informationId,
      });
      expect(await database.information.listPendingLogProjections(10)).toEqual([
        { informationId: atom.informationId, attemptCount: 0 },
      ]);

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "returns only existing atoms from getMany in caller order",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "retries a failed log projection after the runner is recreated",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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
      expect(await database.information.get(atom.informationId)).toBeDefined();
      expect(await database.information.listPendingLogProjections(10)).toEqual([
        { informationId: atom.informationId, attemptCount: 1 },
      ]);
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
      expect(await database.information.listPendingLogProjections(10)).toEqual(
        [],
      );

      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "coalesces concurrent projection calls so one pending atom reaches the sink once",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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
      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "drains every successful pending batch until the outbox is empty",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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
      expect(await database.information.listPendingLogProjections(10)).toEqual(
        [],
      );
      await database.close();
    },
    TEST_TIMEOUT,
  );

  it(
    "checks for a real empty batch when a concurrent short batch enqueues more work",
    async () => {
      const database = await createTestingDatabase();
      await database.migrate();
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

      await Promise.all([runner.projectPending(), runner.drainPending()]);

      expect(projected).toEqual([first.informationId, second.informationId]);
      expect(await database.information.listPendingLogProjections(10)).toEqual(
        [],
      );
      await database.close();
    },
    TEST_TIMEOUT,
  );
});
