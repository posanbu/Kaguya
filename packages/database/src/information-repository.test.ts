/**
 * 架构说明：本测试覆盖信息原子仓储的 append、查询、引用约束与冲突语义，
 * 先以真实 PostgreSQL 行为锁定 append-only 关系图的读写契约，再交由实现补齐。
 * 代码库关系：测试只面向未来的 `createTestingDatabase()` 返回值和 `information`
 * 仓储接口，验证引用顺序、目标 kind 校验、冲突错误与反向引用查询顺序。
 */
import { describe, expect, it } from "vitest";

import {
  freezeInformationAtom,
  informationIdSchema,
  type JsonObject,
  z,
} from "@kaguya/schema";
import { defineInformationKind } from "@kaguya/sdk";

import {
  InformationIdConflictError,
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
) {
  return freezeInformationAtom({
    informationId: informationIdSchema.parse(informationId),
    kind,
    occurredAt,
    source: "module:test",
    payload,
    references: [...references],
  });
}

describe("information repository", () => {
  it("rolls back an atom when a target reference is missing", async () => {
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
      await database.information.getById(inboundAtom.informationId),
    ).toBeUndefined();

    await database.close();
  }, TEST_TIMEOUT);

  it("keeps reference order when storing and reading atoms", async () => {
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

    expect((await database.information.getById(inboundAtom.informationId))?.references).toEqual([
      {
        relation: "core:context",
        informationId: contextAtom.informationId,
      },
    ]);

    await database.close();
  }, TEST_TIMEOUT);

  it("rejects a target kind mismatch", async () => {
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
  }, TEST_TIMEOUT);

  it("rejects duplicate information ids", async () => {
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
    await expect(database.information.append(atom, [])).rejects.toBeInstanceOf(
      InformationIdConflictError,
    );

    await database.close();
  }, TEST_TIMEOUT);

  it("orders reverse-reference reads by atom occurrence and id", async () => {
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

    const replies = await database.information.listByReference({
      relation: "core:caused-by",
      informationId: contextAtom.informationId,
    });

    expect(replies.map((atom) => atom.informationId)).toEqual([
      earlierReply.informationId,
      laterReply.informationId,
    ]);

    await database.close();
  }, TEST_TIMEOUT);

  it("rejects two concurrent appends with the same id", async () => {
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

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      results.find((result): result is PromiseRejectedResult => result.status === "rejected")
        ?.reason,
    ).toBeInstanceOf(InformationIdConflictError);

    await database.close();
  }, TEST_TIMEOUT);
});
