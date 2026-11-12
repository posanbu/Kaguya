/**
 * 媒体增量校验覆盖来源/输入双表到三表、字节类型/限额、PK/UNIQUE及音频/入站协议；历史 TTS 契约保持。
 * 功能概述：验证离线入口在连接前拒绝越权目标、陈旧审查和缺少回执，保证只读文件检查不修复权限。
 * 主要职责：使用独立临时目录和受控连接 spy；覆盖 PG17 索引引号与错误键、方法、谓词；所有文件操作显式等待并清理。
 * 代码库关系：约束 offline-upgrade 的保护边界；真实 PG17 恢复、幂等和事务回滚由部署演练另验。
 * POSIX 权限与 O_NOFOLLOW 是生产部署前提；Windows 不执行此 Linux/Unix 运维入口；纯声明与 schema 校验仍跨平台运行。
 * 输入输出与副作用：只写临时合成目标，不连接数据库或外部服务，不包含真实凭据或群聊内容。
 */
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDatabase } from "@kaguya/database";
import {
  offlineKinds,
  verifyRetainedKinds,
  readRetainedKindContracts,
  readRestrictedFile,
  runOfflineUpgrade,
} from "./offline-upgrade.js";
import { inspectOfflineSchema } from "./offline-schema.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "kaguya-offline-"));
  roots.push(root);
  const cordis =
    "plugins:\n  - {id: service.runtime, name: kaguya/runtime, disabled: false}\n";
  await writeFile(join(root, "cordis.yml"), cordis, { mode: 0o600 });
  const target = {
    connectionString: "postgresql://synthetic.invalid/unused",
    expectedSystemIdentifier: "123456789",
    expectedDatabase: "unused",
    expectedDataDirectory: "/synthetic/pg",
    configRoot: root,
    firstPartyOnly: true,
    configurationReview: {
      cordisSha256: createHash("sha256").update(cordis).digest("hex"),
      pluginNames: ["kaguya/runtime"],
    },
  };
  return { root, target, path: join(root, "target.json") };
}
describe.skipIf(process.platform === "win32")("offline upgrade guard", () => {
  it("requires explicit apply receipts before opening a database", async () => {
    const { target, path } = await fixture();
    await writeFile(path, JSON.stringify(target), { mode: 0o600 });
    const connect = vi.spyOn(PgDatabase, "connect");
    await expect(
      runOfflineUpgrade(["apply", "--target-file", path]),
    ).rejects.toThrow("apply-receipts-required");
    expect(connect).not.toHaveBeenCalled();
  });
  it("rejects dynamic plugins and stale configuration reviews before connecting", async () => {
    const { target, path } = await fixture();
    const connect = vi.spyOn(PgDatabase, "connect");
    target.configurationReview.pluginNames = ["third-party-plugin"];
    await writeFile(path, JSON.stringify(target), { mode: 0o600 });
    await expect(
      runOfflineUpgrade(["inspect", "--target-file", path]),
    ).rejects.toThrow("dynamic-plugin-review-required");
    target.configurationReview.pluginNames = ["kaguya/runtime"];
    target.configurationReview.cordisSha256 = "0".repeat(64);
    await writeFile(path, JSON.stringify(target), { mode: 0o600 });
    await expect(
      runOfflineUpgrade(["verify", "--target-file", path]),
    ).rejects.toThrow("configuration-review-stale");
    expect(connect).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === "win32")(
    "does not chmod files and refuses symlinks",
    async () => {
      const { path, root } = await fixture();
      await writeFile(path, "synthetic", { mode: 0o600 });
      await chmod(path, 0o644);
      const before = await stat(path);
      await expect(readRestrictedFile(path)).rejects.toThrow(
        "restricted-file-required",
      );
      expect((await stat(path)).mode).toBe(before.mode);
      expect(await readFile(path, "utf8")).toBe("synthetic");
      await chmod(path, 0o600);
      const link = join(root, "link");
      await symlink(path, link);
      await expect(readRestrictedFile(link)).rejects.toThrow();
      expect((await readRestrictedFile(path)).toString()).toBe("synthetic");
    },
  );
});

it("includes late MCP, runtime and persistent memory declarations without module creation", () => {
  const definitions = offlineKinds();
  expect(new Set(definitions.map((d) => d.kind)).size).toBe(definitions.length);
  expect(definitions.some((d) => d.kind === "memory.native.revision.v1")).toBe(
    true,
  );
  expect(
    definitions.some((d) => d.kind.includes("mcp") && d.kind.includes("late")),
  ).toBe(true);
  expect(definitions.some((d) => d.kind === "core.delivery.started")).toBe(
    true,
  );
});
it("reports missing epoch and incomplete raw stages without executing SQL writes", async () => {
  const calls: string[] = [];
  const db = {
    query: async (sql: string) => {
      calls.push(sql);
      const rows = sql.includes("information_schema.columns")
        ? [
            { table_name: "memory_native_sources", column_name: "id" },
            { table_name: "memory_raw_checkpoint", column_name: "singleton" },
          ]
        : [];
      return { rows, rowCount: rows.length };
    },
  };
  const errors = await inspectOfflineSchema(db as never, false);
  expect(errors).toContain("epoch-missing");
  expect(errors).toContain("partial-raw-schema");
  expect(calls.every((sql) => /^\s*SELECT/u.test(sql))).toBe(true);
});

it("retains TTS handoff kinds and current media payload schemas in static declarations", () => {
  const kinds = new Map(
    offlineKinds().map((definition) => [definition.kind, definition]),
  );
  for (const name of [
    "core.message.assistant.authorized",
    "agent.heavy.message.draft",
    "agent.heavy.message.prepared",
  ])
    expect(kinds.has(name)).toBe(true);
  expect(
    kinds.get("core.delivery.requested")!.payloadSchema.safeParse({
      adapterId: "synthetic",
      platform: "qq",
      destination: { kind: "group", groupId: "g" },
      turn: null,
      message: {
        kind: "audio",
        resourceId: `sha256:${"a".repeat(64)}`,
        sha256: "a".repeat(64),
        mimeType: "audio/wav",
        byteLength: 4,
        text: "合成正文",
      },
    }).success,
  ).toBe(true);
  expect(
    kinds.get("core.message.inbound.text")!.payloadSchema.safeParse({
      text: "合成图片",
      source: {
        adapterId: "synthetic",
        platform: "qq",
        platformMessageId: "synthetic-message",
        destination: { kind: "group", groupId: "g" },
        senderId: "u",
      },
      contentSegments: [
        {
          kind: "media",
          media: {
            mediaId: `media:${"b".repeat(64)}`,
            position: 0,
            mediaType: "image",
            status: "unavailable",
            resourceId: null,
            mimeType: null,
            byteLength: 0,
          },
        },
      ],
    }).success,
  ).toBe(true);
});

it("preserves every historical kind and refuses unreviewed TTS contract replacement", async () => {
  const prior = [
    {
      kind: "agent.tts.requested.v1",
      contract: { owner: "kaguya.qwen-tts", version: 1 },
    },
  ];
  let rows = structuredClone(prior);
  const db = { query: async () => ({ rows, rowCount: rows.length }) };
  await expect(
    verifyRetainedKinds(db as never, prior, offlineKinds()),
  ).resolves.toBeUndefined();
  rows = [];
  await expect(
    verifyRetainedKinds(db as never, prior, offlineKinds()),
  ).rejects.toThrow("historical-kind-missing");
  rows = [{ ...prior[0]!, contract: { owner: "changed-owner", version: 1 } }];
  await expect(
    verifyRetainedKinds(db as never, prior, offlineKinds()),
  ).rejects.toThrow("historical-kind-contract-changed");
});

it.skipIf(process.platform === "win32")(
  "accepts the default text output module but keeps dynamic TTS review mandatory",
  async () => {
    const f = await fixture();
    const connect = vi
      .spyOn(PgDatabase, "connect")
      .mockRejectedValue(new Error("synthetic-connection-boundary"));
    for (const [plugin, error] of [
      [
        "kaguya/module/agent.message-output.text",
        "synthetic-connection-boundary",
      ],
      ["kaguya/module/plugin.qwen-tts", "dynamic-plugin-review-required"],
    ] as const) {
      const cordis = `plugins:\n  - {id: service.runtime, name: kaguya/runtime, disabled: false}\n  - {id: module.output, name: ${plugin}, disabled: false}\n`;
      f.target.configurationReview = {
        cordisSha256: createHash("sha256").update(cordis).digest("hex"),
        pluginNames: ["kaguya/runtime", plugin],
      };
      await writeFile(join(f.root, "cordis.yml"), cordis, { mode: 0o600 });
      await writeFile(f.path, JSON.stringify(f.target), { mode: 0o600 });
      await expect(
        runOfflineUpgrade(["inspect", "--target-file", f.path]),
      ).rejects.toThrow(error);
    }
    expect(connect).toHaveBeenCalledTimes(1);
  },
);

it("checks both media tables, exact columns, primary keys and source uniqueness", async () => {
  const columns = [
    ["media_sources", "media_id", "text"],
    ["media_sources", "scope", "text"],
    ["media_sources", "source_key", "text"],
    ["media_sources", "metadata", "jsonb"],
    ["media_input_snapshots", "request_key", "text"],
    ["media_input_snapshots", "scope", "text"],
    ["media_input_snapshots", "snapshot", "jsonb"],
  ].map(([table_name, column_name, udt_name]) => ({
    table_name,
    column_name,
    udt_name,
    is_nullable: "NO",
  }));
  const constraints = [
    { table_name: "media_sources", type: "p", columns: "media_id" },
    { table_name: "media_sources", type: "u", columns: "scope source_key" },
    { table_name: "media_input_snapshots", type: "p", columns: "request_key" },
  ];
  let actualColumns = columns,
    actualConstraints = constraints;
  const db = {
    query: async (sql: string) => ({
      rows: sql.includes("information_schema.columns")
        ? actualColumns
        : sql.includes("FROM pg_constraint")
          ? actualConstraints
          : [],
      rowCount: 0,
    }),
  };
  const mediaErrors = (errors: string[]) =>
    errors.filter((error) =>
      /media_sources|media_input_snapshots|partial-schema-stage/.test(error),
    );
  expect(mediaErrors(await inspectOfflineSchema(db as never, true))).toEqual(
    [],
  );
  actualColumns = columns.filter(
    (column) => column.table_name !== "media_input_snapshots",
  );
  expect(await inspectOfflineSchema(db as never, false)).toContain(
    "partial-schema-stage",
  );
  actualColumns = columns.map((column) =>
    column.column_name === "metadata"
      ? { ...column, udt_name: "text" }
      : column,
  );
  expect(await inspectOfflineSchema(db as never, true)).toContain(
    "type:media_sources.metadata",
  );
  actualColumns = columns;
  actualConstraints = constraints.filter(
    (constraint) => constraint.type !== "u",
  );
  expect(await inspectOfflineSchema(db as never, true)).toContain(
    "unique:media_sources",
  );
  actualConstraints = constraints.filter(
    (constraint) => constraint.table_name !== "media_input_snapshots",
  );
  expect(await inspectOfflineSchema(db as never, true)).toContain(
    "primary:media_input_snapshots",
  );
});

it("checks media bytes while accepting the earlier source and snapshot stage", async () => {
  const resourceColumns = [
    ["resource_id", "text"],
    ["mime_type", "text"],
    ["sha256", "text"],
    ["bytes", "bytea"],
    ["touched_at", "timestamptz"],
  ].map(([column_name, udt_name]) => ({
    table_name: "media_resources",
    column_name,
    udt_name,
    is_nullable: "NO",
  }));
  const earlierTables = [
    {
      table_name: "media_sources",
      column_name: "media_id",
      udt_name: "text",
      is_nullable: "NO",
    },
    {
      table_name: "media_input_snapshots",
      column_name: "request_key",
      udt_name: "text",
      is_nullable: "NO",
    },
  ];
  let columns = [...resourceColumns, ...earlierTables];
  const validConstraints = [
    {
      table_name: "media_resources",
      type: "p",
      columns: "resource_id",
      expression: null,
    },
    {
      table_name: "media_resources",
      type: "c",
      columns: "bytes",
      expression:
        "((octet_length(bytes) > 0) AND (octet_length(bytes) <= 16777216))",
    },
  ];
  let constraints = validConstraints;
  const db = {
    query: async (sql: string) => ({
      rows: sql.includes("information_schema.columns")
        ? columns
        : sql.includes("FROM pg_constraint")
          ? constraints
          : [],
      rowCount: 0,
    }),
  };
  const relevant = (errors: string[]) =>
    errors.filter((error) =>
      /media_resources|partial-schema-stage/.test(error),
    );
  expect(relevant(await inspectOfflineSchema(db as never, false))).toEqual([]);
  columns = earlierTables;
  expect(relevant(await inspectOfflineSchema(db as never, false))).toEqual([]);
  expect(await inspectOfflineSchema(db as never, true)).toContain(
    "table:media_resources",
  );
  columns = resourceColumns;
  expect(await inspectOfflineSchema(db as never, false)).toContain(
    "partial-schema-stage",
  );
  for (const invalid of [{ udt_name: "text" }, { is_nullable: "YES" }]) {
    columns = [...resourceColumns, ...earlierTables].map((column) =>
      column.column_name === "bytes" ? { ...column, ...invalid } : column,
    );
    expect(await inspectOfflineSchema(db as never, false)).toContain(
      "type:media_resources.bytes",
    );
  }
  columns = [...resourceColumns, ...earlierTables].filter(
    (column) => column.column_name !== "bytes",
  );
  expect(await inspectOfflineSchema(db as never, false)).toContain(
    "column:media_resources.bytes",
  );
  columns = [...resourceColumns, ...earlierTables];
  constraints = validConstraints.filter(
    (constraint) => constraint.type !== "c",
  );
  expect(await inspectOfflineSchema(db as never, false)).toContain(
    "checks:media_resources",
  );
  constraints = validConstraints.map((constraint) =>
    constraint.type === "c"
      ? { ...constraint, expression: "true" }
      : constraint,
  );
  expect(await inspectOfflineSchema(db as never, false)).toContain(
    "check-expression:media_resources.bytes",
  );
  constraints = [];
  expect(await inspectOfflineSchema(db as never, false)).toContain(
    "primary:media_resources",
  );
});

it("reads historical TTS kinds before the legacy contract column exists", async () => {
  const calls: string[] = [];
  let present = false;
  const prior = [{ kind: "agent.tts.requested.v1", contract: null }];
  const db = {
    query: async (sql: string) => {
      calls.push(sql);
      return {
        rows: sql.includes("information_schema.columns")
          ? [{ present }]
          : prior,
        rowCount: 1,
      };
    },
  };
  expect(await readRetainedKindContracts(db as never)).toEqual(prior);
  expect(calls[1]).toBe(
    "SELECT kind,NULL::jsonb contract FROM information_kinds ORDER BY kind",
  );
  present = true;
  expect(await readRetainedKindContracts(db as never)).toEqual(prior);
  expect(calls[3]).toBe(
    "SELECT kind,contract FROM information_kinds ORDER BY kind",
  );
  expect(calls.every((sql) => sql.startsWith("SELECT"))).toBe(true);
});

it("accepts PG17 quoted index keys without weakening index semantics", async () => {
  const name = "information_lifecycle_position_idx";
  const valid = {
    name,
    table_name: "information_lifecycle",
    is_unique: true,
    valid: true,
    definition: `CREATE UNIQUE INDEX ${name} ON public.information_lifecycle USING btree ("position")`,
  };
  let row = valid;
  const db = {
    query: async (sql: string) => ({
      rows: sql.includes("FROM pg_index") ? [row] : [],
      rowCount: 0,
    }),
  };
  const result = async () =>
    (await inspectOfflineSchema(db as never, false)).filter(
      (issue) => issue === `index:${name}`,
    );
  expect(await result()).toEqual([]);
  row = {
    ...valid,
    definition: valid.definition.replace('"position"', "position"),
  };
  expect(await result()).toEqual([]);
  for (const invalid of [
    { table_name: "other_table" },
    { is_unique: false },
    { valid: false },
    { definition: valid.definition.replace('"position"', '"Position"') },
    { definition: valid.definition.replace('"position"', "information_id") },
    { definition: valid.definition.replace('"position"', '"position" DESC') },
    { definition: valid.definition.replace("USING btree", "USING hash") },
    { definition: valid.definition + ' WHERE ("position" > 0)' },
    { definition: valid.definition + " INCLUDE (information_id)" },
  ]) {
    row = { ...valid, ...invalid };
    expect(await result()).toEqual([`index:${name}`]);
  }
});
