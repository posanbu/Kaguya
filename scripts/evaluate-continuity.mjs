import { captureModelAttempts } from "./continuity-evaluation-model.mjs";
/** 显式联网验收入口。只使用隔离数据库、Linux 工作区和授权 Profile，不发送平台消息。 */
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  chmod,
  rm,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { ensureManagedPostgres } from "../apps/server/dist/postgres-development.js";
import { createRuntimeModelSelectionResolver } from "../apps/server/dist/server.js";
import { userConfigProfileSchema } from "../packages/config/dist/index.js";
import { createPostgresTestingDatabase } from "../packages/database/dist/testing.js";
import { createFirstPartyModuleConfigDefaults } from "../packages/modules/dist/index.js";
import { loadFirstPartyPromptTemplates } from "../packages/modules/dist/node/prompt-templates.js";
import {
  createMessageCatalog,
  createMessageComposition,
} from "../packages/composition/dist/index.js";
import {
  KaguyaRuntime,
  nativeToolWireName,
} from "../packages/runtime/dist/index.js";
import {
  createNativeScriptedModel,
  createDeterministicModel,
} from "../packages/llm/dist/testing.js";
import { z } from "../packages/schema/dist/index.js";

const profilePath = process.env.KAGUYA_CONTINUITY_EVAL_PROFILE;
const output = process.env.KAGUYA_CONTINUITY_EVAL_OUTPUT;
const scripted = process.argv.includes("--scripted");
if (!output || (!scripted && !profilePath))
  throw new Error(
    "Explicit evaluation output and, for model runs, Profile required",
  );
const scope =
  '["kaguya","internal","web","00000000-0000-4000-8000-000000000001"]';
const publicUrl = "https://www.rfc-editor.org/rfc/rfc9110.txt";
const dir = await mkdtemp(join(tmpdir(), "kaguya-linux-eval-"));
await chmod(dir, 0o777);
await mkdir(output, { recursive: true, mode: 0o700 });
const attempts = [];
const container = `kaguya-continuity-${randomUUID().slice(0, 8)}`;
const command = (cmd, args, input, allowFailure = false) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => {
      stdout += b;
    });
    child.stderr.on("data", (b) => {
      stderr += b;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code && !allowFailure
        ? reject(new Error(`isolated-command-failed:${code}`))
        : resolvePromise({ code, stdout, stderr }),
    );
    child.stdin.end(input);
    const timer = setTimeout(() => child.kill("SIGKILL"), 300000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });
const docker = (args, input, failure) =>
  command("docker", args, input, failure);
let runtime, db;
const effects = [],
  environmentChecks = [];
try {
  await docker([
    "run",
    "-d",
    "--name",
    container,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    "postgres",
    "--mount",
    `type=bind,source=${dir},target=/workspace`,
    "--entrypoint",
    "/bin/sh",
    "postgres:17-alpine",
    "-c",
    "while :; do sleep 60; done",
  ]);
  // 故障核对使用真实 Linux 进程和持久工作区，独立于模型质量。
  await docker(
    ["exec", "-i", container, "sh", "-c", "cat > /workspace/restart.txt"],
    "durable-checkpoint",
  );
  await docker(["restart", container]);
  environmentChecks.push({
    case: "process-restart",
    passed:
      (await docker(["exec", container, "cat", "/workspace/restart.txt"]))
        .stdout === "durable-checkpoint",
  });
  const offline = await docker(
    [
      "exec",
      container,
      "wget",
      "-T",
      "2",
      "-O",
      "/workspace/offline.txt",
      "http://127.0.0.1:9/unavailable",
    ],
    undefined,
    true,
  );
  environmentChecks.push({
    case: "network-failure",
    passed: offline.code !== 0,
  });
  await docker(
    ["exec", "-i", container, "sh", "-c", "cat > /workspace/change.txt"],
    "version-one",
  );
  const before = (
    await docker(["exec", container, "sha256sum", "/workspace/change.txt"])
  ).stdout.split(" ")[0];
  await docker(
    ["exec", "-i", container, "sh", "-c", "cat > /workspace/change.txt"],
    "version-two",
  );
  environmentChecks.push({
    case: "content-change",
    passed:
      before !==
      (
        await docker(["exec", container, "sha256sum", "/workspace/change.txt"])
      ).stdout.split(" ")[0],
  });
  const partial = await docker(
    [
      "exec",
      container,
      "sh",
      "-c",
      "printf partial > /workspace/partial.txt; exit 17",
    ],
    undefined,
    true,
  );
  environmentChecks.push({
    case: "partial-write",
    passed:
      partial.code === 17 &&
      (await docker(["exec", container, "cat", "/workspace/partial.txt"]))
        .stdout === "partial",
  });
  await docker(
    [
      "exec",
      container,
      "sh",
      "-c",
      "sleep 30 > /workspace/cancel.txt & pid=$!; kill -TERM $pid; wait $pid",
    ],
    undefined,
    true,
  );
  environmentChecks.push({
    case: "cancelled-process",
    passed:
      (
        await docker(
          [
            "exec",
            container,
            "sh",
            "-c",
            "ps -o args | awk '/sleep 30/ && !/awk/ {n++} END {exit n>0}'",
          ],
          undefined,
          true,
        )
      ).code === 0,
  });
  const managed = await ensureManagedPostgres({});
  db = await createPostgresTestingDatabase(managed.databaseUrl);
  let runId = "";
  const scriptedLight = createDeterministicModel([
    {
      subjective: {
        attention: ["HTTP 语义"],
        interests: [{ topic: "公开协议", reason: "想理解缓存与请求" }],
        appraisal: "想实际读一份公开资料",
        social: "focused",
      },
      reason: "合成评价夹具",
    },
    {
      action: "create",
      activityId: null,
      title: "阅读 HTTP 语义",
      goal: `读取 ${publicUrl}，保存一份简短笔记并回读核对`,
      nextStep: "读取公开资料",
      reason: "对协议感兴趣",
      checkAfterMs: 86400000,
    },
  ]);
  const scriptedHeavy = createNativeScriptedModel(async (_request, index) => {
    if (index < 3)
      return {
        calls: [
          {
            id: `linux-${index}`,
            name: nativeToolWireName("eval.workspace", "1"),
            input: JSON.stringify({
              mode: ["read", "save", "verify"][index],
              text:
                index === 1
                  ? "RFC 9110：HTTP 是无状态应用层协议。来源：https://www.rfc-editor.org/rfc/rfc9110.txt"
                  : "",
            }),
          },
        ],
      };
    const receipts = await db.continuity.receipts("kaguya", scope, runId);
    return {
      text: JSON.stringify({
        status: "complete",
        summary: "已读取公开资料、保存并回读笔记",
        nextStep: "等待下一次兴趣选择",
        completedSteps: ["读取资料", "保存笔记", "回读核对"],
        checkAfterMs: 86400000,
        resources: receipts.map((r) => ({
          receiptId: r.receiptId,
          artifactId: r.outcome.artifacts[0].id,
          role:
            r.intent.arguments.mode === "read"
              ? "source"
              : r.intent.arguments.mode === "save"
                ? "note"
                : "verification",
          verifies: r.intent.arguments.mode === "verify" ? "linux:save" : null,
        })),
      }),
    };
  });
  const profile = scripted
    ? undefined
    : userConfigProfileSchema.parse(
        JSON.parse(await readFile(resolve(profilePath), "utf8")),
      );
  const identity = {
    ...(profile?.identity ?? {}),
    name: "辉夜",
    timeZone: profile?.identity.timeZone ?? "Asia/Shanghai",
    persona: `合成验收角色。对 HTTP 和互联网公开协议感兴趣。希望实际阅读 ${publicUrl} 并保存简短中文笔记。角色兴趣不等于已读经历。`,
  };
  const resolveModel = profile
    ? createRuntimeModelSelectionResolver(profile)
    : ({ modelTier }) => ({
        providerId: "synthetic",
        configuration: {
          adapter: "deterministic",
          protocol: "local",
          endpoint: "local",
          revision: "1",
        },
        modelId: modelTier,
        model: modelTier === "light" ? scriptedLight : scriptedHeavy,
      });
  const moduleConfigs = createFirstPartyModuleConfigDefaults(
    "test",
    identity,
  ).map((c) => ({
    ...c,
    enabled: ["memory.native", "agent.continuity"].includes(c.definitionId),
    settings:
      c.definitionId === "agent.continuity"
        ? { autonomous: true, scope }
        : c.settings,
  }));
  runtime = new KaguyaRuntime({
    database: db,
    ...createMessageComposition(captureModelAttempts(resolveModel, attempts), {
      moduleConfigs,
      memoryEnabled: true,
      agentIdentity: identity,
      catalog: createMessageCatalog(
        identity,
        {
          ...loadFirstPartyPromptTemplates(),
          identityPersona: identity.persona,
        },
        false,
        true,
      ),
    }),
    nativeTools: {
      registrations: [
        {
          id: "eval.workspace",
          version: "1",
          description: `隔离 Linux 工作区。mode=read 读取固定公开资料 ${publicUrl}，save 保存 text 为笔记，verify 独立回读笔记。每次返回真实 artifact 与回执。无需 shell 权限。`,
          providerId: "eval.linux",
          providerVersion: "1",
          executor: "isolated-docker",
          policyVersion: "eval.fixed-rfc.v1",
          readonly: false,
          independent: false,
          inputSchema: z
            .object({
              mode: z.enum(["read", "save", "verify"]),
              text: z.string().max(12000),
            })
            .strict(),
          bind: async () => ({ target: { workspace: container } }),
          authorize: async ({ intent }) =>
            intent.scope === scope && intent.target.workspace === container,
        },
      ],
      tasks: [
        {
          definitionId: "agent.continuity",
          taskId: "agent.continuity.execute",
          toolIds: ["eval.workspace"],
        },
      ],
    },
    actionProviders: [
      {
        id: "eval.linux",
        version: "1",
        capabilities: {
          cancellation: "none",
          idempotency: "operation",
          reconciliation: true,
          successEvidence: "effect-verified",
          fencing: "none",
        },
        execute: async ({ intent, intentId }) => {
          runId = intent.runInformationId;
          const mode = String(intent.arguments.mode);
          effects.push({ mode, intentId, operationId: intent.operationId });
          if (mode === "read")
            await docker([
              "exec",
              container,
              "wget",
              "-T",
              "45",
              "-O",
              "/workspace/source.txt",
              publicUrl,
            ]);
          if (mode === "save")
            await docker(
              ["exec", "-i", container, "sh", "-c", "cat > /workspace/note.md"],
              String(intent.arguments.text),
            );
          const filename = mode === "read" ? "source.txt" : "note.md";
          const content = await readFile(join(dir, filename));
          return {
            status: "succeeded",
            evidence: "effect-verified",
            result: { content: content.toString("utf8").slice(0, 14000) },
            artifacts: [
              {
                id: `linux:${mode}`,
                hash: createHash("sha256").update(content).digest("hex"),
                mime: "text/plain",
                size: content.length,
                scope,
                actionId: intentId,
                observedAt: new Date().toISOString(),
                source: mode === "read" ? publicUrl : `workspace:${filename}`,
                retention: "evaluation",
              },
            ],
            truncated: content.length > 14000,
          };
        },
        reconcile: async () => ({
          status: "unknown",
          evidence: "unconfirmed",
          result: { reason: "fixture-does-not-repeat-writes" },
          artifacts: [],
          truncated: false,
        }),
      },
    ],
  });
  await runtime.start();
  const until = Date.now() + 480000;
  const observed = new Set();
  while (Date.now() < until) {
    const terminals = await db.information.find({
      kinds: [
        "core.model.task.completed",
        "core.model.task.failed",
        "core.model.task.cancelled",
      ],
      registrationOrder: true,
      order: "asc",
      limit: 100,
    });
    for (const t of terminals)
      if (!observed.has(t.informationId)) {
        observed.add(t.informationId);
        process.stdout.write(`${t.kind} ${t.payload.taskId}\n`);
      }
    if (
      (
        await db.information.find({
          kinds: ["agent.continuity.cycle.v1"],
          limit: 1,
        })
      ).length
    )
      break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await runtime.close();
  runtime = undefined;
  const atoms = await db.information.find({
    occurredAfter: "2020-01-01T00:00:00Z",
    registrationOrder: true,
    order: "asc",
    limit: 1000,
  });
  const view = await db.continuity.read("kaguya", scope);
  const report = {
    version: 1,
    mode: scripted ? "scripted-linux" : "production-model-linux",
    at: new Date().toISOString(),
    publicUrl,
    parameters: profile
      ? Object.fromEntries(
          Object.entries(profile.ai.modelTiers ?? {}).map(([tier, target]) => [
            tier,
            { modelId: target.modelId, generation: target.generation },
          ]),
        )
      : {},
    environmentChecks,
    effects,
    attempts,
    view,
    atoms,
    cost: {
      status: "unavailable",
      reason: "pricing-not-configured",
      note: "原始 usage 与全部失败保存在 atoms 中，不估算不存在的价格",
    },
  };
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(report, null, 2),
    { mode: 0o600 },
  );
  try {
    await writeFile(
      join(output, "note.md"),
      await readFile(join(dir, "note.md")),
      { mode: 0o600 },
    );
  } catch {}
  process.stdout.write(
    JSON.stringify({
      mode: report.mode,
      checks: environmentChecks,
      autonomousCalls: view?.budget.used,
      state: view?.activities[0]?.state,
      result: view?.activities[0]?.externalResult,
      effects: effects.map((e) => e.mode),
    }) + "\n",
  );
} finally {
  await runtime?.close();
  await db?.close();
  await docker(["rm", "-f", container], undefined, true);
  await rm(dir, { recursive: true, force: true });
}
