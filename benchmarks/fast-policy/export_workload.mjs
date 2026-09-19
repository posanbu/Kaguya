#!/usr/bin/env node
/**
 * 功能概述：为 issue #181 从生产 Information 账本导出首次冻结的 Planner 输入，
 * 保留真实工作负载及溯源，同时禁止读取同一请求的后验模型结果或补入未来上下文。
 * 主要职责：parseArguments 解析配置目录、私有输出路径与源码根目录；exportWorkload
 * 在 PostgreSQL REPEATABLE READ / READ ONLY 事务中读取请求和它已声明的上下文；
 * atomRecord 恢复账本公开字段；writePrivateFile 独占创建权限 0600 的数据和清单。
 * 代码库关系：从 packages/database 的 pg 依赖读取 information_atoms/references，
 * 与 Runtime 的 core.model.task.requested、agent.turn.plan 冻结契约一致；下游
 * fast-policy benchmark 消费 source-private.jsonl，生产 Runtime 不加载本文件。
 * 输入输出与副作用：配置中的数据库凭据只驻留内存，终端只显示计数和内容哈希；
 * 输出包含私人会话，默认写入 gitignored .data，目录权限 0700；已有输出拒绝覆盖。
 * 不修改账本、不启动或重载服务、不调用模型；失败仅报告固定消息和安全错误代码。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const excludedContextKinds = new Set([
  "core.model.task.completed",
  "core.model.task.failed",
  "core.model.task.cancelled",
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArguments(argv) {
  const options = { repoRoot: defaultRepoRoot };
  const names = new Map([
    ["--repo-root", "repoRoot"],
    ["--config-root", "configRoot"],
    ["--output", "output"],
  ]);
  for (let i = 0; i < argv.length; i += 2) {
    const name = names.get(argv[i]);
    if (!name || !argv[i + 1] || argv[i + 1].startsWith("--")) {
      throw new Error("Invalid arguments");
    }
    options[name] = path.resolve(argv[i + 1]);
  }
  options.configRoot ??= path.join(options.repoRoot, ".data/kaguya-config");
  options.output ??= path.join(
    options.repoRoot,
    ".data/fast-policy/source-private.jsonl",
  );
  return options;
}

function atomRecord(row, references) {
  return {
    informationId: row.information_id,
    kind: row.kind,
    occurredAt: row.occurred_at,
    source: row.source,
    payload: row.payload,
    references: references.get(row.information_id) ?? [],
  };
}

async function writePrivateFile(filename, text) {
  const file = await fs.open(filename, "wx", 0o600);
  try {
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

// 仅转换首次冻结请求；计数与原始请求一起保留，缺失引用不靠后验结果补齐。
function freezeRequests(requests, contextById, references) {
  let missingContextCount = 0;
  let excludedContextCount = 0;
  let futureContextCount = 0;
  const records = requests.map((request) => {
    const payload = request.payload;
    const context = [];
    for (const id of payload.contextInformationIds) {
      const row = contextById.get(id);
      if (!row) {
        missingContextCount++;
      } else if (excludedContextKinds.has(row.kind)) {
        excludedContextCount++;
      } else if (
        Date.parse(row.occurred_at) > Date.parse(request.occurred_at)
      ) {
        futureContextCount++;
      } else {
        context.push(atomRecord(row, references));
      }
    }
    return {
      id: sha256(request.information_id).slice(0, 16),
      source_request_id: request.information_id,
      occurred_at: request.occurred_at,
      prompt: payload.prompt,
      context_atoms: context,
      request_meta: {
        taskId: payload.taskId,
        version: payload.version,
        outputMode: payload.outputMode,
        promptKind: payload.promptKind,
        promptTemplateId: payload.promptTemplateId,
        promptTemplateDigest: payload.promptTemplateDigest,
        promptDigest: payload.promptDigest,
        sourceInformationId: payload.sourceInformationId,
        contextInformationId: payload.contextInformationId,
        contextInformationIds: payload.contextInformationIds,
        provenance: payload.provenance,
        modelId: payload.resolvedModel?.modelId,
        providerId: payload.resolvedModel?.providerId,
      },
    };
  });
  return {
    records,
    missingContextCount,
    excludedContextCount,
    futureContextCount,
  };
}

async function exportWorkload(options) {
  const startedAt = new Date().toISOString();
  const configIndex = JSON.parse(
    await fs.readFile(path.join(options.configRoot, "index.json"), "utf8"),
  );
  const profileId = configIndex.selectedProfileId;
  if (typeof profileId !== "string" || !/^[\w-]+$/.test(profileId)) {
    throw new Error("Invalid selected profile");
  }
  const profile = JSON.parse(
    await fs.readFile(
      path.join(options.configRoot, "profiles", `${profileId}.json`),
      "utf8",
    ),
  );
  if (typeof profile.runtime?.databaseUrl !== "string") {
    throw new Error("Missing database URL");
  }
  const require = createRequire(
    path.join(options.repoRoot, "packages/database/package.json"),
  );
  const { Client } = require("pg");
  const client = new Client({
    connectionString: profile.runtime.databaseUrl,
    application_name: "kaguya-issue-181-readonly-export",
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
  });
  let records;
  let snapshotTime;
  let missingContextCount = 0;
  let excludedContextCount = 0;
  let futureContextCount = 0;
  try {
    await client.connect();
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    snapshotTime = (
      await client.query("SELECT CURRENT_TIMESTAMP AS time")
    ).rows[0].time.toISOString();
    const requests = (
      await client.query(
        `SELECT information_id, kind, occurred_at, source, payload
         FROM information_atoms
         WHERE kind = $1 AND payload->>'taskId' = $2
         ORDER BY occurred_at, information_id`,
        ["core.model.task.requested", "agent.turn.plan"],
      )
    ).rows;
    const allIds = [
      ...new Set(
        requests.flatMap((request) => {
          const payload = request.payload;
          if (
            !Array.isArray(payload.contextInformationIds) ||
            typeof payload.prompt?.text !== "string" ||
            !Array.isArray(payload.prompt.variables)
          ) {
            throw new Error("Invalid frozen request");
          }
          return payload.contextInformationIds;
        }),
      ),
    ];
    const contextRows = (
      await client.query(
        `SELECT information_id, kind, occurred_at, source, payload
         FROM information_atoms WHERE information_id = ANY($1::text[])`,
        [allIds],
      )
    ).rows;
    const referenceRows = (
      await client.query(
        `SELECT information_id, relation, target_information_id
         FROM information_references
         WHERE information_id = ANY($1::text[])
         ORDER BY information_id, ordinal`,
        [allIds],
      )
    ).rows;
    const references = new Map();
    for (const row of referenceRows) {
      const entries = references.get(row.information_id) ?? [];
      entries.push({
        relation: row.relation,
        informationId: row.target_information_id,
      });
      references.set(row.information_id, entries);
    }
    const contextById = new Map(
      contextRows.map((row) => [row.information_id, row]),
    );
    ({
      records,
      missingContextCount,
      excludedContextCount,
      futureContextCount,
    } = freezeRequests(requests, contextById, references));
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }

  const text = records.map((record) => JSON.stringify(record) + "\n").join("");
  const gitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: options.repoRoot,
    encoding: "utf8",
  }).trim();
  const manifest = {
    schema_version: 1,
    source: "kaguya-information-ledger-frozen-planner-requests",
    source_git_sha: gitSha,
    source_request_count: records.length,
    unique_prompt_count: new Set(
      records.map((record) => record.request_meta.promptDigest),
    ).size,
    source_sha256: sha256(text),
    missing_context_count: missingContextCount,
    excluded_model_terminal_context_count: excludedContextCount,
    future_context_count: futureContextCount,
    first_request_at: records[0]?.occurred_at ?? null,
    last_request_at: records.at(-1)?.occurred_at ?? null,
    snapshot_at: snapshotTime,
    export_started_at: startedAt,
    export_completed_at: new Date().toISOString(),
    database_access: "REPEATABLE READ READ ONLY; rolled back",
    selection: "all frozen agent.turn.plan requests; no result filtering",
    contains_private_conversation_data: true,
    post_request_context_excluded: true,
  };
  const outputDirectory = path.dirname(options.output);
  const manifestPath = path.join(outputDirectory, "source-manifest.json");
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await fs.chmod(outputDirectory, 0o700);
  for (const filename of [options.output, manifestPath]) {
    try {
      await fs.lstat(filename);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Output already exists");
  }
  await writePrivateFile(options.output, text);
  await writePrivateFile(
    manifestPath,
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(JSON.stringify(manifest));
}

export { parseArguments, freezeRequests, writePrivateFile, exportWorkload };

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: node export_workload.mjs [--repo-root PATH] [--config-root PATH] [--output PRIVATE_JSONL]\nExports frozen Planner requests using a read-only transaction; never calls a model.",
    );
  } else
    try {
      await exportWorkload(parseArguments(process.argv.slice(2)));
    } catch (error) {
      const code =
        typeof error.code === "string" && /^[A-Z0-9_]{1,32}$/.test(error.code)
          ? error.code
          : "EXPORT_FAILED";
      console.error(
        JSON.stringify({ error: "Private workload export failed", code }),
      );
      process.exitCode = 1;
    }
}
