/**
 * 功能概述：将 participation 导出的旧历史前缀接到真实 native Memory，生成离线证据 JSONL。
 * 主要职责：canonicalJson/hash 校验 Python 冻结哈希；validateRequest 拒绝额外元数据、错配引用、
 * 乱序、重复或越水位来源；NativeMemoryRequestError 将批次失败绑定到阶段、物理行号和请求 ID；
 * replayNativeMemory 为每个请求创建独立 PGlite，顺序写入身份/来源，用原文摘录形成节点后调用
 * 生产 ingest、publish 和 freeze；runNativeMemoryFile 验证全部请求后以独占私有文件输出。
 * 代码库关系：Python memory adapter 负责截点与近期/旧历史切分；本文件复用 database/testing、
 * memory/native 和 schema 的生产契约。它不读取生产数据库、配置、API key 或环境中的连接串。
 * 输入输出与副作用：仅接收明确导出的旧历史与目标账号，输出绑定请求哈希的来源证据、媒体缺失
 * 和字符预算；每个内存库在 finally 关闭。形成策略是确定性摘录，不调用模型或 embedding。
 * 原始平台发生时间仅作出处；记忆可见时间采用 receivedAt。已撤回与纯媒体正文不形成文字节点。
 * 回应省略数据库随机 publication ID 与当前时间，保留稳定节点 ID；不把字符数报告为 token。
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestingDatabase } from "../../packages/database/src/testing.js";
import {
  createNativeMemoryAccess,
  memoryScope,
  type NativeMemoryNode,
} from "../../packages/memory/src/index.js";
import {
  freezeInformationAtom,
  informationAtomSchema,
  type JsonObject,
} from "../../packages/schema/src/index.js";

export const ADAPTER = "native-extractive/v1";
type Scope = {
  platform: string;
  adapterId: string;
  accountId: string;
  groupId: string;
};
type History = {
  recordId: string;
  captureSeq: number;
  platformMessageId: string;
  senderId: string;
  senderName: string | null;
  receivedAt: string;
  occurredAt: string;
  text: string | null;
  mentions: string[];
  mediaTypes: string[];
  isOwnMessage: boolean;
  replySourceId: string | null;
  replySenderId: string | null;
  unresolvedReply: boolean;
  retracted: boolean;
  recallSourceId?: string;
};
export type NativeRequest = {
  requestId: string;
  adapter: typeof ADAPTER;
  scope: Scope;
  sourceWatermark: number;
  prefixSha256: string;
  earlierHistory: History[];
  targetUser: string;
};

/** Python encoded(): sorted keys, compact JSON, Unicode preserved, trailing LF. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, entry]) => [key, canonical(entry)]),
      );
    if (typeof item === "number" && !Number.isSafeInteger(item))
      throw new Error("Memory request numbers must be safe integers");
    return item;
  };
  return JSON.stringify(canonical(value)) + "\n";
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
const nonblank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
const timestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /(Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value));
// Python 截点使用微秒；Date.parse 单独比较会漏掉同一毫秒内倒退的来源。
const receivedMicroseconds = (value: string) =>
  BigInt(Date.parse(value)) * 1000n +
  BigInt(
    (value.match(/[Tt ]\d{2}:\d{2}:\d{2}\.(\d+)/)?.[1] ?? "")
      .padEnd(6, "0")
      .slice(3, 6),
  );
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(nonblank);
const nullable = (value: unknown) => value === null || nonblank(value);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const historyFields = new Set([
  "recordId",
  "captureSeq",
  "platformMessageId",
  "senderId",
  "senderName",
  "receivedAt",
  "occurredAt",
  "text",
  "mentions",
  "mediaTypes",
  "isOwnMessage",
  "replySourceId",
  "replySenderId",
  "unresolvedReply",
  "retracted",
  "recallSourceId",
]);

export function validateRequest(value: unknown): NativeRequest {
  if (
    !object(value) ||
    value.adapter !== ADAPTER ||
    !object(value.scope) ||
    Object.keys(value).sort().join(",") !==
      "adapter,earlierHistory,prefixSha256,requestId,scope,sourceWatermark,targetUser" ||
    Object.keys(value.scope).sort().join(",") !==
      "accountId,adapterId,groupId,platform" ||
    !Object.values(value.scope).every(nonblank) ||
    !nonblank(value.targetUser) ||
    !Number.isSafeInteger(value.sourceWatermark) ||
    (value.sourceWatermark as number) < 0 ||
    !Array.isArray(value.earlierHistory)
  )
    throw new Error("Invalid native Memory request");
  const { requestId, ...body } = value;
  if (
    requestId !== hash(body) ||
    value.prefixSha256 !== hash(value.earlierHistory)
  )
    throw new Error("Native Memory request or prefix hash mismatch");
  const senders = new Map<string, string>(),
    platformIds = new Set<string>();
  let previousSeq = 0;
  let previousTime: bigint | undefined;
  for (const row of value.earlierHistory) {
    if (
      !object(row) ||
      Object.keys(row).some((key) => !historyFields.has(key)) ||
      !nonblank(row.recordId) ||
      !nonblank(row.platformMessageId) ||
      !nonblank(row.senderId) ||
      !nullable(row.senderName) ||
      !Number.isSafeInteger(row.captureSeq) ||
      (row.captureSeq as number) <= previousSeq ||
      (row.captureSeq as number) > (value.sourceWatermark as number) ||
      !timestamp(row.receivedAt) ||
      !timestamp(row.occurredAt) ||
      (previousTime !== undefined &&
        receivedMicroseconds(row.receivedAt) < previousTime) ||
      (row.text !== null && typeof row.text !== "string") ||
      !strings(row.mentions) ||
      !strings(row.mediaTypes) ||
      !nullable(row.replySourceId) ||
      !nullable(row.replySenderId) ||
      typeof row.unresolvedReply !== "boolean" ||
      typeof row.retracted !== "boolean" ||
      typeof row.isOwnMessage !== "boolean" ||
      row.isOwnMessage !== (row.senderId === value.scope.accountId) ||
      (row.retracted &&
        (row.text !== null ||
          row.mediaTypes.length !== 0 ||
          !nonblank(row.recallSourceId))) ||
      (!row.retracted &&
        (typeof row.text !== "string" || "recallSourceId" in row)) ||
      (row.replySourceId === null
        ? row.replySenderId !== null
        : row.unresolvedReply ||
          senders.get(row.replySourceId as string) !== row.replySenderId) ||
      senders.has(row.recordId) ||
      platformIds.has(row.platformMessageId)
    )
      throw new Error(
        "Invalid, duplicate, unordered or out-of-prefix Memory source",
      );
    senders.set(row.recordId, row.senderId);
    platformIds.add(row.platformMessageId);
    previousSeq = row.captureSeq as number;
    previousTime = receivedMicroseconds(row.receivedAt);
  }
  return structuredClone(value) as NativeRequest;
}

/** 错误正文只含位置与哈希；JSON/数据库原始错误留在 cause，避免 CLI 打印语料片段。 */
export class NativeMemoryRequestError extends Error {
  readonly requestId: string | null;
  constructor(
    readonly phase: "parse" | "validate" | "replay",
    readonly lineNumber: number,
    value: unknown,
    cause: unknown,
  ) {
    const requestId =
      object(value) &&
      typeof value.requestId === "string" &&
      /^[a-f0-9]{64}$/.test(value.requestId)
        ? value.requestId
        : null;
    super(
      `Native Memory ${phase} failed at JSONL line ${lineNumber} (request ${requestId ?? "unknown"})`,
      { cause },
    );
    this.name = "NativeMemoryRequestError";
    this.requestId = requestId;
  }
}

function uuid(seed: unknown): string {
  const bytes = hash(seed).slice(0, 32).split("");
  bytes[12] = "5";
  bytes[16] = "8";
  const s = bytes.join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}
const excerpt = (value: string, limit: number) =>
  Array.from(value).slice(0, limit).join("");

export async function replayNativeMemory(value: unknown) {
  const request = validateRequest(value);
  const database = await createTestingDatabase();
  try {
    await database.prepareSchema();
    const kinds = [
      "core.message.inbound.text",
      "memory.identity.platform.account.entity",
      "memory.identity.platform.account.binding",
    ] as const;
    await database.information.synchronizeKinds([...kinds]);
    const sourceById = new Map<string, History>();
    const rows = request.earlierHistory.filter(
      (row) => !row.retracted && row.text?.trim(),
    );
    const scope = memoryScope({
      ...request.scope,
      destination: { kind: "group", groupId: request.scope.groupId },
    });
    const owner = (sender: string) =>
      `person:${uuid([request.scope, sender, "person"])}`;
    const sourceId = (row: History) =>
      `benchmark-source:${hash([request.scope, row.recordId])}`;
    const detailId = (row: History) =>
      uuid([request.scope, row.recordId, "detail"]);
    const asOf =
      request.earlierHistory.at(-1)?.receivedAt ?? "1970-01-01T00:00:00.000Z";
    const append = async (
      informationId: string,
      kind: string,
      payload: JsonObject,
      occurredAt: string,
      references: { relation: string; informationId: string }[] = [],
    ) =>
      database.information.append(
        freezeInformationAtom(
          informationAtomSchema.parse({
            informationId,
            kind,
            payload,
            occurredAt,
            source: "benchmark:native-extractive",
            references,
          }),
        ),
        references.map(({ relation }) => ({
          relation,
          required: true,
          multiple: false,
        })),
      );
    const seen = new Set<string>();
    const details: NativeMemoryNode[] = [];
    for (const row of rows) {
      if (!seen.has(row.senderId)) {
        seen.add(row.senderId);
        const accountId = `benchmark-account:${hash([request.scope, row.senderId])}`;
        await append(
          accountId,
          kinds[1],
          {
            platform: request.scope.platform,
            adapterId: request.scope.adapterId,
            accountId: row.senderId,
          },
          row.receivedAt,
        );
        await append(
          `benchmark-binding:${hash([request.scope, row.senderId])}`,
          kinds[2],
          { personInformationId: owner(row.senderId).slice("person:".length) },
          row.receivedAt,
          [{ relation: "core:binds", informationId: accountId }],
        );
      }
      const id = sourceId(row);
      sourceById.set(id, row);
      await append(
        id,
        kinds[0],
        {
          text: row.text!,
          source: {
            platform: request.scope.platform,
            adapterId: request.scope.adapterId,
            senderId: row.senderId,
            selfId: request.scope.accountId,
            destination: { kind: "group", groupId: request.scope.groupId },
          },
        },
        row.receivedAt,
      );
      const accepted = await database.memoryGraph.native.ingest({
        id,
        scope,
        ownerId: owner(row.senderId),
        text: row.text!,
        occurredAt: row.receivedAt,
        collectedAt: row.receivedAt,
        sourceType: "inbound",
        participants: [
          {
            accountId: row.senderId,
            ownerId: owner(row.senderId),
            role: "speaker",
            nickname: row.senderName,
            card: null,
          },
        ],
        replyTo: null,
      });
      if (!accepted) throw new Error("Native Memory rejected a replay source");
      details.push({
        id: detailId(row),
        content: `${row.senderId}: ${row.text}`,
        metadata: {
          system: "native-v1",
          kind: "person",
          ownerId: owner(row.senderId),
          scope,
          level: 1,
          revision: 1,
          status: "active",
          locked: false,
          sourceIds: [id],
          aliases: [row.senderId],
          tags: [],
          occurredAt: row.receivedAt,
        },
      });
    }
    for (let offset = 0; offset < details.length; offset += 100)
      await database.memoryGraph.native.publish({
        operationId: `details:${offset}`,
        actor: "automatic",
        nodes: details
          .slice(offset, offset + 100)
          .map((node) => ({ node, expectedRevision: 0 })),
      });
    const summaries: { node: NativeMemoryNode; sources: History[] }[] = [];
    const addSummary = (
      kind: "person" | "conversation",
      ownerId: string,
      sources: History[],
    ) => {
      if (!sources.length) return;
      summaries.push({
        sources,
        node: {
          id: uuid([request.scope, ownerId, "summary"]),
          content: sources
            .map((row) => `${row.senderId}: ${excerpt(row.text!, 400)}`)
            .join("\n"),
          metadata: {
            system: "native-v1",
            kind,
            ownerId,
            scope,
            level: 0,
            revision: 1,
            status: "active",
            locked: false,
            sourceIds: sources.map(sourceId),
            aliases: [],
            tags: [],
            occurredAt: sources.at(-1)!.receivedAt,
          },
        },
      });
    };
    addSummary("conversation", `conversation:${scope}`, rows.slice(-3));
    addSummary(
      "person",
      owner(request.targetUser),
      rows.filter((row) => row.senderId === request.targetUser).slice(-1),
    );
    if (summaries.length) {
      const endpoints = [
        ...new Set(
          summaries.flatMap((summary) => summary.sources.map(detailId)),
        ),
      ];
      await database.memoryGraph.native.publish({
        operationId: "summaries",
        actor: "automatic",
        nodes: summaries.map(({ node }) => ({ node, expectedRevision: 0 })),
        expectedVersions: Object.fromEntries(endpoints.map((id) => [id, 1])),
        edges: summaries.flatMap(({ node, sources }) =>
          sources.map((row) => ({
            sourceId: node.id,
            targetId: detailId(row),
            relation: "summarizes",
            metadata: {},
          })),
        ),
      });
    }
    const access = createNativeMemoryAccess({
      enabled: true,
      store: database.memoryGraph.native,
    });
    const context = {
      scope,
      owners: [owner(request.targetUser), `conversation:${scope}`],
      asOf,
      query: excerpt(
        rows
          .slice(-3)
          .map((row) => row.text)
          .join("\n"),
        512,
      ),
    };
    // 固定已发布上界，避免把尚未走生产 formation batch 的摘录再次作为 pendingEvidence 加入预算。
    const cutoff = await database.memoryGraph.native.cutoff(context);
    const snapshot = await access.freeze({ ...context, cutoff });
    const evidence = [
      ...snapshot.fixed.map((node) => ({
        node,
        truncated: false,
        channels: ["fixed"],
      })),
      ...snapshot.recalled.map(({ node, truncated, traces }) => ({
        node,
        truncated,
        channels: [...new Set(traces.map((trace) => trace.channel))],
      })),
    ].map(({ node, truncated, channels }) => ({
      nodeId: node.id,
      text: node.content,
      truncated,
      channels,
      sourceIds: node.metadata.sourceIds.map(
        (id) => sourceById.get(id)!.recordId,
      ),
      sources: node.metadata.sourceIds.map((id) => {
        const row = sourceById.get(id)!;
        return {
          recordId: row.recordId,
          senderId: row.senderId,
          receivedAt: row.receivedAt,
          occurredAt: row.occurredAt,
          mediaTypes: row.mediaTypes,
          missingMediaContent: row.mediaTypes.length > 0,
          replySourceId: row.replySourceId,
          unresolvedReply: row.unresolvedReply,
        };
      }),
    }));
    return {
      requestId: request.requestId,
      adapter: ADAPTER,
      scope: request.scope,
      sourceWatermark: request.sourceWatermark,
      prefixSha256: request.prefixSha256,
      targetUser: request.targetUser,
      evidence,
      metrics: {
        networkRequests: 0,
        embeddingRequests: 0,
        formation: "deterministic-excerpts",
        inputRecords: request.earlierHistory.length,
        ingestedRecords: rows.length,
        retractedRecords: request.earlierHistory.filter((row) => row.retracted)
          .length,
        mediaOnlyRecords: request.earlierHistory.filter(
          (row) =>
            !row.retracted && !row.text?.trim() && row.mediaTypes.length > 0,
        ).length,
        inputCharacters: rows.reduce(
          (sum, row) => sum + Array.from(row.text!).length,
          0,
        ),
        evidenceCharacters: evidence.reduce(
          (sum, item) => sum + Array.from(item.text).length,
          0,
        ),
        fixedNodes: snapshot.fixed.length,
        recalledNodes: snapshot.recalled.length,
        dynamicCharacters: snapshot.budget.dynamicCharacters,
        omittedNodeIds: snapshot.budget.omittedNodeIds,
        tokens: null,
      },
    };
  } finally {
    await database.close();
  }
}

/** 记录相关生产实现的源码哈希；这不是已执行测试或远端 CI 的证明。 */
async function implementationFingerprint() {
  const paths = [
    "benchmarks/participation/native-memory.ts",
    "pnpm-lock.yaml",
    "packages/database/src/native-memory.ts",
    "packages/database/src/native-memory-history.ts",
    "packages/database/src/native-memory-proof.ts",
    "packages/database/src/testing.ts",
    "packages/database/src/pglite-driver.ts",
    "packages/memory/src/native.ts",
    "packages/agent-contracts/src/memory-graph.ts",
  ];
  const implementationFiles = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(new URL(`../../${path}`, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
  return {
    implementationSha256: hash(implementationFiles),
    implementationFiles,
  };
}

export async function runNativeMemoryFile(
  requestPath: string,
  outputPath: string,
) {
  if (resolve(requestPath) === resolve(outputPath))
    throw new Error("Output must differ from requests");
  const requests: { request: NativeRequest; lineNumber: number }[] = [];
  const ids = new Set<string>();
  const lines = (await readFile(requestPath, "utf8")).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    const lineNumber = index + 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (cause) {
      throw new NativeMemoryRequestError("parse", lineNumber, undefined, cause);
    }
    try {
      const request = validateRequest(value);
      if (ids.has(request.requestId))
        throw new Error("Memory requests must be unique");
      ids.add(request.requestId);
      requests.push({ request, lineNumber });
    } catch (cause) {
      throw new NativeMemoryRequestError("validate", lineNumber, value, cause);
    }
  }
  if (!requests.length) throw new Error("Memory requests must be nonempty");
  const implementation = await implementationFingerprint();
  const responses = [];
  for (const { request, lineNumber } of requests) {
    try {
      const response = await replayNativeMemory(request);
      responses.push({
        ...response,
        metrics: { ...response.metrics, ...implementation },
      });
    } catch (cause) {
      throw new NativeMemoryRequestError("replay", lineNumber, request, cause);
    }
  }
  // 成功完成整个批次后才创建文件；wx 防止覆盖旧运行，0600 保护本地匿名/私有语料。
  await writeFile(outputPath, responses.map(canonicalJson).join(""), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    requests: responses.length,
    networkRequests: 0,
    implementationSha256: implementation.implementationSha256,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--requests" || args[2] !== "--output") {
    process.stderr.write(
      "Usage: tsx benchmarks/participation/native-memory.ts --requests PATH --output PATH\n",
    );
    process.exitCode = 2;
  } else {
    runNativeMemoryFile(args[1]!, args[3]!).then(
      (summary) => process.stdout.write(canonicalJson(summary)),
      (error: unknown) => {
        process.stderr.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exitCode = 1;
      },
    );
  }
}
