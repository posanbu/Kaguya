/**
 * readRetainedKindContracts 兼容旧 Kind 表尚无 contract 列的增量阶段，迁移前仍冻结全部历史 Kind。
 * 功能概述：提供 inspect/verify/apply 离线增量升级，不启动 Runtime、插件工厂、适配器或工具宿主。
 * 主要职责：runOfflineUpgrade 严格读取受限目标文件，验证集群/数据库/目录身份和回执；apply 独占
 * 3041107 锁并在同一事务中复用 prepareSchema 和完整静态 Kind 契约同步，随后迁移 Lifecycle 配置。
 * 代码库关系：scripts/deployment/recovery.py 生成备份；single_owner 持同一 advisory lock 排斥双实例。
 * 输入输出与副作用：inspect/verify 用数据库只读事务且不 chmod；apply 显式写 schema/配置，保留数据与 epoch，
 * 不 recover Memory、不领任务、不重发 unknown；错误仅输出稳定码，不输出连接串、配置或 SQL 错误正文。
 * 新默认文字输出属于一方配置；既有第三方TTS和历史Kind保留原契约，不执行或放行动态插件。
 * 停止回执只是现场证据，管理员仍须阻止旧进程和 supervisor 自动重启；旧未受锁保护服务不能在线迁移。
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  KaguyaDatabase,
  PgDatabase,
  assertSupportedPostgresVersion,
  type SqlDatabase,
} from "@kaguya/database";
import { migrateLifecycleConfig, parseCordisTreeText } from "@kaguya/config";
import {
  createFirstPartyModuleConfigDefaults,
  lifecycleSettingsSchema,
  offlineFirstPartyKinds,
} from "@kaguya/modules";
import { createRuntimeKindRegistry } from "@kaguya/runtime";
import { mcpLateResultInformationKind } from "@kaguya/mcp";
import { z } from "@kaguya/schema";
import type { InformationKindDefinition } from "@kaguya/sdk";
import { inspectOfflineSchema } from "./offline-schema.js";

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const absolute = z.string().refine(isAbsolute);
const receiptRef = z.object({ path: absolute, sha256 }).strict();
export const offlineTargetSchema = z
  .object({
    connectionString: z.string().min(1),
    expectedSystemIdentifier: z.string().regex(/^\d+$/),
    expectedDatabase: z.string().min(1),
    expectedDataDirectory: absolute,
    configRoot: absolute,
    firstPartyOnly: z.literal(true),
    configurationReview: z
      .object({ cordisSha256: sha256, pluginNames: z.array(z.string()).min(1) })
      .strict(),
    backupReceipt: receiptRef.optional(),
    stoppedReceipt: receiptRef.optional(),
  })
  .strict();
type Target = z.infer<typeof offlineTargetSchema>;
type Transaction = Pick<SqlDatabase, "query" | "exec">;
export class OfflineUpgradeError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
function fail(code: string): never {
  throw new OfflineUpgradeError(code);
}
const hash = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");

/** 拒绝符号链接和宽松权限；只通过已打开的同一文件描述符检查并读取，不自动修复文件权限。 */
export async function readRestrictedFile(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      fail("restricted-file-required");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
async function fileHash(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      stat.uid !== process.getuid?.()
    )
      fail("restricted-file-required");
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false }))
      digest.update(chunk);
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}
export function offlineKinds(): readonly InformationKindDefinition<
  string,
  any
>[] {
  const byName = new Map<string, InformationKindDefinition<string, any>>();
  for (const definition of [
    ...createRuntimeKindRegistry({ definitions: [] }).definitions(),
    ...offlineFirstPartyKinds,
    mcpLateResultInformationKind,
  ]) {
    if (
      byName.has(definition.kind) &&
      byName.get(definition.kind) !== definition
    )
      fail("kind-definition-conflict");
    byName.set(definition.kind, definition);
  }
  return [...byName.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}
const allowedPlugins = new Set([
  ...[
    "configuration",
    "logging",
    "catalog",
    "database",
    "adapter",
    "runtime",
    "http",
    "web-ui",
  ].map((s) => `kaguya/${s}`),
  ...[
    "agent.heavy",
    "agent.message-output.text",
    "memory.native",
    "adapter.web",
    "adapter.napcat",
    "memory.identity",
    "agent.lifecycle",
    "agent.router",
    "agent.situation",
    "plugin.qq-expression",
    "agent.attention.arousal",
    "agent.heartbeat.short",
  ].map((s) => `kaguya/module/${s}`),
]);
async function checkConfiguration(target: Target) {
  if (
    target.configurationReview.pluginNames.some(
      (name) => !allowedPlugins.has(name),
    )
  )
    fail("dynamic-plugin-review-required");
  const content = await readRestrictedFile(
    join(target.configRoot, "cordis.yml"),
  );
  if (hash(content) !== target.configurationReview.cordisSha256)
    fail("configuration-review-stale");
  const actual = parseCordisTreeText(content.toString("utf8"))
    .plugins.map((p) => p.name)
    .sort();
  if (
    actual.some((name) => !allowedPlugins.has(name)) ||
    JSON.stringify(actual) !==
      JSON.stringify([...target.configurationReview.pluginNames].sort())
  )
    fail("dynamic-plugin-review-required");
}
async function checkReceipt(
  target: Target,
  ref: z.infer<typeof receiptRef>,
  stopped: boolean,
) {
  const content = await readRestrictedFile(ref.path);
  if (hash(content) !== ref.sha256) fail("receipt-checksum-mismatch");
  const receipt = JSON.parse(content.toString("utf8"));
  if (
    receipt.systemIdentifier !== target.expectedSystemIdentifier ||
    receipt.database !== target.expectedDatabase ||
    receipt.dataDirectory !== target.expectedDataDirectory ||
    receipt.configRoot !== target.configRoot
  )
    fail("receipt-target-mismatch");
  if (stopped) {
    const age = Date.now() - Date.parse(receipt.capturedAt);
    if (
      receipt.serviceStopped !== true ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 600_000
    )
      fail("stopped-receipt-stale");
  } else {
    for (const name of ["database.dump", "globals.sql"]) {
      const expected = sha256.safeParse(receipt.files?.[name]);
      if (
        !expected.success ||
        (await fileHash(join(dirname(ref.path), name))) !== expected.data
      )
        fail("backup-checksum-mismatch");
    }
  }
}
async function checkIdentity(db: Transaction, target: Target) {
  const identity = (
    await db.query<{
      system_identifier: string;
      database: string;
      data_directory: string;
      schema: string;
    }>(`
    SELECT system_identifier::text,current_database() database,current_setting('data_directory') data_directory,current_schema() schema
    FROM pg_control_system()
  `)
  ).rows[0];
  if (
    !identity ||
    identity.system_identifier !== target.expectedSystemIdentifier ||
    identity.database !== target.expectedDatabase ||
    identity.data_directory !== target.expectedDataDirectory ||
    identity.schema !== "public"
  )
    fail("database-target-mismatch");
}
async function verifyKinds(
  db: Transaction,
  definitions: readonly InformationKindDefinition<string, any>[],
) {
  for (const d of definitions) {
    const row = (
      await db.query<{ valid: boolean }>(
        "SELECT ($2::jsonb IS NULL OR contract=$2::jsonb) valid FROM information_kinds WHERE kind=$1",
        [
          d.kind,
          d.persistence
            ? JSON.stringify({ ...d.persistence, references: d.references })
            : null,
        ],
      )
    ).rows[0];
    if (!row?.valid) fail("kind-contract-mismatch");
  }
}
/** 未迁移的旧表可能没有 contract 列；只读缺省为 null，实际新增列仍由 prepareSchema 负责。 */
export async function readRetainedKindContracts(db: Transaction) {
  const hasContract = (
    await db.query<{ present: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='information_kinds' AND column_name='contract') present",
    )
  ).rows[0]?.present;
  return (
    await db.query<{ kind: string; contract: unknown }>(
      hasContract
        ? "SELECT kind,contract FROM information_kinds ORDER BY kind"
        : "SELECT kind,NULL::jsonb contract FROM information_kinds ORDER BY kind",
    )
  ).rows;
}
/** 只允许本次完整静态声明同步契约；未知插件及历史Kind必须逐项保留原契约。 */
export async function verifyRetainedKinds(
  db: Transaction,
  previous: readonly { kind: string; contract: unknown }[],
  definitions: readonly InformationKindDefinition<string, any>[],
) {
  const declared = new Set(definitions.map((definition) => definition.kind));
  const current = new Map(
    (
      await db.query<{ kind: string; contract: unknown }>(
        "SELECT kind,contract FROM information_kinds ORDER BY kind",
      )
    ).rows.map((row) => [row.kind, row.contract]),
  );
  for (const row of previous) {
    if (!current.has(row.kind)) fail("historical-kind-missing");
    if (
      !declared.has(row.kind) &&
      !isDeepStrictEqual(current.get(row.kind), row.contract)
    )
      fail("historical-kind-contract-changed");
  }
}
async function checkSchema(db: Transaction, complete: boolean) {
  const issues = await inspectOfflineSchema(db, complete);
  if (issues.length) fail(`schema-invalid:${issues.join(",")}`);
  const metadata = (
    await db.query<{
      singleton: boolean;
      version: number;
      information_protocol: string;
    }>(
      "SELECT singleton,version,information_protocol FROM kaguya_schema_metadata",
    )
  ).rows;
  if (
    metadata.length !== 1 ||
    metadata[0]?.singleton !== true ||
    metadata[0]?.version !== 2 ||
    metadata[0].information_protocol !== "router-light-heavy.v2"
  )
    fail("unsupported-protocol");
}
/** 把数据库包内部的分阶段事务绑定到已经持锁的外层事务；任何失败回滚本次全部 SQL。 */
function facade(tx: Transaction): SqlDatabase {
  return {
    query: tx.query.bind(tx),
    exec: tx.exec.bind(tx),
    transaction: async (run) => run(tx),
    close: async () => {},
  };
}
export async function runOfflineUpgrade(
  args = process.argv.slice(2),
): Promise<object> {
  const [command, option, path, ...rest] = args;
  if (
    !command ||
    !["inspect", "verify", "apply"].includes(command) ||
    option !== "--target-file" ||
    !path ||
    !isAbsolute(path) ||
    rest.length
  )
    fail("usage");
  const target = offlineTargetSchema.parse(
    JSON.parse((await readRestrictedFile(path)).toString("utf8")),
  );
  await checkConfiguration(target);
  if (command === "apply") {
    if (!target.backupReceipt || !target.stoppedReceipt)
      fail("apply-receipts-required");
    await checkReceipt(target, target.backupReceipt, false);
    await checkReceipt(target, target.stoppedReceipt, true);
  }
  const sql = await PgDatabase.connect({
    connectionString: target.connectionString,
    startupOptions:
      "-c search_path=public -c statement_timeout=120000 -c lock_timeout=10000 -c application_name=kaguya-offline-upgrade" +
      (command === "apply" ? "" : " -c default_transaction_read_only=on"),
  });
  try {
    await assertSupportedPostgresVersion(sql);
    const definitions = offlineKinds();
    const result = await sql.transaction(async (tx) => {
      if (command !== "apply")
        await tx.exec(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
      await checkIdentity(tx, target);
      if (command === "apply") {
        const lock = (
          await tx.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_xact_lock(3041107) locked",
          )
        ).rows[0];
        if (!lock?.locked) fail("single-owner-busy");
        const peers = (
          await tx.query<{ count: string }>(
            "SELECT count(*)::text count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
          )
        ).rows[0];
        if (peers?.count !== "0") fail("database-clients-active");
        const existing = (
          await tx.query<{ name: string }>(
            "SELECT tablename name FROM pg_tables WHERE schemaname=current_schema() ORDER BY tablename",
          )
        ).rows;
        for (const table of existing)
          await tx.exec(
            `LOCK TABLE "${table.name.replaceAll('"', '""')}" IN SHARE ROW EXCLUSIVE MODE`,
          );
      }
      await checkSchema(tx, command === "verify");
      const priorKinds =
        command === "apply" ? await readRetainedKindContracts(tx) : [];
      const originalEpoch = (
        await tx.query<{ value: string | null }>(
          "SELECT CASE WHEN to_regclass('memory_native_epoch') IS NULL THEN NULL ELSE 'present' END value",
        )
      ).rows[0]?.value;
      const epochBefore = originalEpoch
        ? (
            await tx.query<{ value: string }>(
              "SELECT row_to_json(e)::text value FROM memory_native_epoch e WHERE id=true",
            )
          ).rows[0]?.value
        : null;
      if (command === "apply") {
        const database = new KaguyaDatabase(facade(tx));
        await database.prepareSchema();
        await checkSchema(tx, true);
        if (
          epochBefore !== null &&
          epochBefore !==
            (
              await tx.query<{ value: string }>(
                "SELECT row_to_json(e)::text value FROM memory_native_epoch e WHERE id=true",
              )
            ).rows[0]?.value
        )
          fail("epoch-changed");
        await database.information.synchronizeKinds(
          definitions.map((d) => d.kind),
          definitions,
        );
        await verifyRetainedKinds(tx, priorKinds, definitions);
      }
      if (command !== "inspect") await verifyKinds(tx, definitions);
      const hasEpoch = (
        await tx.query<{ present: boolean }>(
          "SELECT to_regclass('memory_native_epoch') IS NOT NULL present",
        )
      ).rows[0]?.present;
      const epoch = hasEpoch
        ? (
            await tx.query<{ source_after: string; started_at: string }>(
              "SELECT source_after::text,started_at::text FROM memory_native_epoch WHERE id=true",
            )
          ).rows[0]
        : null;
      if (command === "apply") {
        // advisory 锁跨越配置迁移；文件 journal 可独立重放，SQL 提交失败时不能恢复旧数据覆盖新事实。
        await migrateLifecycleConfig(
          target.configRoot,
          createFirstPartyModuleConfigDefaults(),
          lifecycleSettingsSchema,
        );
      }
      return {
        command,
        databaseVerified: true,
        declaredKinds: definitions.length,
        epochFingerprint: hash(JSON.stringify(epoch)),
      };
    });
    return result;
  } finally {
    await sql.close();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.stdout.write(JSON.stringify(await runOfflineUpgrade()) + "\n");
  } catch (error) {
    process.stderr.write(
      JSON.stringify({
        error:
          error instanceof OfflineUpgradeError
            ? error.code
            : "offline-upgrade-failed",
      }) + "\n",
    );
    process.exitCode = 1;
  }
}
