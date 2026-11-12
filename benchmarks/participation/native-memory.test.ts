/**
 * 功能概述：验证离线 participation bridge 使用真实 native Memory，且不会混入另一个历史前缀。
 * 主要职责：request 构造完全虚构、带哈希的旧历史；用例检查原文来源、目标/范围绑定、撤回、
 * 纯媒体标记、错误水位与批次输出覆盖保护，并比较独立数据库重建的确定性结果。
 * 补充目标/登录账号隔离、平台时间出处、未来元数据和引用归属拒绝，以及逐请求失败归因。
 * 代码库关系：直接调用 native-memory.ts；实际建库、ingest/publish/freeze 与关闭均由其完成。
 * 输入输出与副作用：只创建隔离内存 PGlite 和测试临时输出文件，无外部模型或数据库连接。
 * 异步路径全部 await 完成，采用仓库 15 秒单用例预算；含多次建库的用例显式留 30 秒。
 * 没有固定 sleep、后台轮询或默认 waitFor，失败时临时目录仍通过 finally 删除。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as testing from "../../packages/database/src/testing.js";
import {
  ADAPTER,
  NativeMemoryRequestError,
  canonicalJson,
  hash,
  replayNativeMemory,
  runNativeMemoryFile,
  validateRequest,
  type NativeRequest,
} from "./native-memory.js";

function row(seq: number, text: string | null, senderId = "person-a") {
  return {
    recordId: `r${seq}`,
    captureSeq: seq,
    platformMessageId: `p${seq}`,
    senderId,
    senderName: null,
    receivedAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}+00:00`,
    occurredAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}+00:00`,
    text,
    mentions: [],
    mediaTypes: [] as string[],
    isOwnMessage: false,
    replySourceId: null,
    replySenderId: null,
    unresolvedReply: false,
    retracted: text === null,
    ...(text === null ? { recallSourceId: `recall-${seq}` } : {}),
  };
}
function request(
  history = [row(1, "周六参加读书会。"), row(2, "我带纸笔。", "person-b")],
  targetUser = "person-a",
  groupId = "group-a",
): NativeRequest {
  const body: Omit<NativeRequest, "requestId"> = {
    adapter: ADAPTER,
    scope: {
      platform: "qq",
      adapterId: "fictional-adapter",
      accountId: "bot-demo",
      groupId,
    },
    sourceWatermark: 10,
    prefixSha256: hash(history),
    earlierHistory: history,
    targetUser,
  };
  return { ...body, requestId: hash(body) };
}
function rehash(input: NativeRequest): NativeRequest {
  const { requestId: _id, ...body } = input;
  body.prefixSha256 = hash(body.earlierHistory);
  return { ...body, requestId: hash(body) };
}

describe("native participation memory", () => {
  it("matches a Python-generated Unicode request hash", () => {
    const body = {
      adapter: ADAPTER,
      scope: {
        platform: "qq",
        adapterId: "fictional-adapter",
        accountId: "bot-demo",
        groupId: "群-a",
      },
      sourceWatermark: 0,
      prefixSha256:
        "37517e5f3dc66819f61f5a7bb8ace1921282415f10551d2defa5c3eb0985b570",
      earlierHistory: [],
      targetUser: "人-a",
    };
    // 来自 Python encoded()，不以本文件的 hash() 生成 expected。
    const requestId =
      "83ccd9bcea0d0db00d4a3b3a4f9b56a7ee6d1da5e6fd97b3a8dd4a25464dea5f";
    expect(hash(body)).toBe(requestId);
    expect(validateRequest({ ...body, requestId }).targetUser).toBe("人-a");
  });

  it("rejects tampering, duplicate sources, future sequence and foreign reply before replay", () => {
    const valid = request();
    expect(validateRequest(valid)).toEqual(valid);
    expect(() => validateRequest({ ...valid, targetUser: "tampered" })).toThrow(
      /hash/,
    );
    expect(() =>
      validateRequest(
        rehash({ ...valid, earlierHistory: [row(1, "a"), row(1, "a")] }),
      ),
    ).toThrow(/source/);
    expect(() =>
      validateRequest(rehash({ ...valid, sourceWatermark: 1 })),
    ).toThrow(/source/);
    expect(() =>
      validateRequest(
        rehash({
          ...valid,
          earlierHistory: [{ ...row(1, "a"), replySourceId: "future" }],
        }),
      ),
    ).toThrow(/source/);
    expect(() =>
      validateRequest(
        rehash({
          ...valid,
          earlierHistory: [{ ...row(1, null), text: "withdrawn secret" }],
        }),
      ),
    ).toThrow(/source/);
  });

  it("rejects future metadata and reply actor mismatches even with a valid prefix hash", () => {
    const valid = request();
    const future = {
      ...row(1, "旧消息"),
      futureProfile: "future-derived-interest",
    };
    expect(() =>
      validateRequest(rehash({ ...valid, earlierHistory: [future] })),
    ).toThrow(/source/);
    const first = row(1, "我会参加", "person-a");
    const reply = {
      ...row(2, "好", "person-b"),
      replySourceId: "r1",
      replySenderId: "person-c",
    };
    expect(() =>
      validateRequest(rehash({ ...valid, earlierHistory: [first, reply] })),
    ).toThrow(/source/);
    expect(() =>
      validateRequest(
        rehash({
          ...valid,
          earlierHistory: [first, { ...reply, replySourceId: null }],
        }),
      ),
    ).toThrow(/source/);
    expect(() =>
      validateRequest(
        rehash({
          ...valid,
          earlierHistory: [
            first,
            { ...reply, replySenderId: "person-a", unresolvedReply: true },
          ],
        }),
      ),
    ).toThrow(/source/);
    const correct = rehash({
      ...valid,
      earlierHistory: [first, { ...reply, replySenderId: "person-a" }],
    });
    expect(validateRequest(correct)).toEqual(correct);
    expect(() =>
      validateRequest(
        rehash({
          ...valid,
          earlierHistory: [
            { ...first, receivedAt: "2026-01-01T00:00:01.000002+00:00" },
            {
              ...row(2, "微秒内倒退"),
              receivedAt: "2026-01-01T00:00:01.000001+00:00",
            },
          ],
        }),
      ),
    ).toThrow(/source/);
  });

  it("rebuilds the real native graph deterministically with attributable fixed and dynamic evidence", async () => {
    const input = request();
    const first = await replayNativeMemory(input);
    const second = await replayNativeMemory(input);
    expect(second).toEqual(first);
    expect(first.metrics).toMatchObject({
      networkRequests: 0,
      embeddingRequests: 0,
      ingestedRecords: 2,
      fixedNodes: 2,
      tokens: null,
    });
    expect(first.metrics.recalledNodes).toBeGreaterThan(0);
    expect(
      first.evidence.some((item) => item.channels.includes("entity")),
    ).toBe(true);
    expect(first.evidence.flatMap((item) => item.sourceIds).sort()).toEqual(
      expect.arrayContaining(["r1", "r2"]),
    );
    expect(
      first.evidence.every(
        (item) =>
          item.sourceIds.length > 0 &&
          item.sourceIds.every((id) => ["r1", "r2"].includes(id)),
      ),
    ).toBe(true);
    expect(
      first.evidence
        .flatMap((item) => item.sources)
        .map((source) => source.senderId),
    ).toEqual(expect.arrayContaining(["person-a", "person-b"]));
  }, 30_000);

  it("isolates prefixes and scopes, excludes withdrawn text and preserves unread media flags", async () => {
    const before = await replayNativeMemory(
      request([row(1, "PRIVATE_OLD_TEXT")]),
    );
    const media = {
      ...row(2, "图里内容未保存", "person-b"),
      mediaTypes: ["image"],
    };
    const after = await replayNativeMemory(
      request(
        [row(1, null), media, { ...row(3, ""), mediaTypes: ["voice"] }],
        "person-b",
        "group-b",
      ),
    );
    expect(JSON.stringify(before.evidence)).toContain("PRIVATE_OLD_TEXT");
    expect(JSON.stringify(after.evidence)).not.toContain("PRIVATE_OLD_TEXT");
    expect(after.scope.groupId).toBe("group-b");
    expect(after.targetUser).toBe("person-b");
    expect(after.metrics).toMatchObject({
      ingestedRecords: 1,
      retractedRecords: 1,
      mediaOnlyRecords: 1,
    });
    expect(
      after.evidence
        .flatMap((item) => item.sourceIds)
        .every((id) => id === "r2"),
    ).toBe(true);
    expect(
      after.evidence
        .flatMap((item) => item.sources)
        .every((source) => source.missingMediaContent),
    ).toBe(true);
    const empty = await replayNativeMemory(request([]));
    expect(empty.evidence).toEqual([]);
    expect(empty.metrics.ingestedRecords).toBe(0);
  }, 30_000);

  it("keeps target summaries and login namespaces separate while preserving observed source times", async () => {
    const old = {
      ...row(1, "甲的原文", "person-a"),
      occurredAt: "2025-12-31T23:58:00+00:00",
    };
    // 平台时钟可以领先；已收到的时间元数据保留，但可见性仍由 receivedAt 决定。
    const clockAhead = {
      ...row(2, "乙的原文", "person-b"),
      occurredAt: "2027-01-01T00:00:00+00:00",
    };
    const firstRequest = request([old, clockAhead]);
    const first = await replayNativeMemory(firstRequest);
    const otherTarget = await replayNativeMemory(
      rehash({ ...firstRequest, targetUser: "person-b" }),
    );
    const otherLogin = await replayNativeMemory(
      rehash({
        ...firstRequest,
        scope: { ...firstRequest.scope, accountId: "another-login" },
      }),
    );
    const fixed = (result: typeof first) =>
      result.evidence.filter((item) => item.channels.includes("fixed"));
    expect(
      fixed(first)
        .filter((item) => item.sourceIds.length === 1)
        .map((item) => item.sourceIds),
    ).toEqual([["r1"]]);
    expect(
      fixed(otherTarget)
        .filter((item) => item.sourceIds.length === 1)
        .map((item) => item.sourceIds),
    ).toEqual([["r2"]]);
    expect(otherLogin.scope.accountId).toBe("another-login");
    expect(
      otherLogin.evidence.every(
        (item) => !first.evidence.some((prior) => prior.nodeId === item.nodeId),
      ),
    ).toBe(true);
    expect(first.evidence.flatMap((item) => item.sources)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: "r1",
          senderId: "person-a",
          receivedAt: old.receivedAt,
          occurredAt: old.occurredAt,
        }),
        expect.objectContaining({
          recordId: "r2",
          senderId: "person-b",
          receivedAt: clockAhead.receivedAt,
          occurredAt: clockAhead.occurredAt,
        }),
      ]),
    );
  }, 30_000);

  it("writes bound responses and source fingerprints without overwriting a prior run", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "kaguya-native-participation-"),
    );
    try {
      const input = join(directory, "requests.jsonl"),
        output = join(directory, "responses.jsonl");
      const value = request([]);
      await writeFile(input, canonicalJson(value));
      const summary = await runNativeMemoryFile(input, output);
      expect(summary).toMatchObject({ requests: 1, networkRequests: 0 });
      const original = await readFile(output, "utf8");
      const response = JSON.parse(original);
      expect(response.requestId).toBe(value.requestId);
      expect(response.metrics.implementationSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        response.metrics.implementationFiles[
          "packages/database/src/native-memory.ts"
        ],
      ).toMatch(/^[a-f0-9]{64}$/);
      await expect(runNativeMemoryFile(input, output)).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await readFile(output, "utf8")).toBe(original);
      await writeFile(input, canonicalJson(value) + canonicalJson(value));
      await expect(
        runNativeMemoryFile(input, join(directory, "duplicate.jsonl")),
      ).rejects.toMatchObject({
        phase: "validate",
        lineNumber: 2,
        requestId: value.requestId,
        cause: { message: "Memory requests must be unique" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("attributes validation and parsing failures to physical lines without writing partial results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaguya-native-invalid-"));
    try {
      const input = join(directory, "requests.jsonl"),
        output = join(directory, "responses.jsonl");
      const value = request([]);
      await writeFile(
        input,
        canonicalJson(value) +
          "\n" +
          canonicalJson({ ...value, targetUser: "tampered" }),
      );
      await expect(runNativeMemoryFile(input, output)).rejects.toMatchObject({
        name: "NativeMemoryRequestError",
        phase: "validate",
        lineNumber: 3,
        requestId: value.requestId,
      });
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(
        input,
        canonicalJson(value) + '\n{"private-sentinel": invalid-json}\n',
      );
      const failed = await runNativeMemoryFile(input, output).catch(
        (error: unknown) => error,
      );
      expect(failed).toBeInstanceOf(NativeMemoryRequestError);
      expect(failed).toMatchObject({
        phase: "parse",
        lineNumber: 3,
        requestId: null,
      });
      expect((failed as Error).message).not.toContain("private-sentinel");
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("attributes native replay failures to the request and retains the original cause", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kaguya-native-failure-"));
    const cause = new Error("synthetic database initialization failure");
    const create = vi
      .spyOn(testing, "createTestingDatabase")
      .mockRejectedValueOnce(cause);
    try {
      const input = join(directory, "requests.jsonl"),
        output = join(directory, "responses.jsonl");
      const value = request([]);
      await writeFile(input, "\n" + canonicalJson(value));
      await expect(runNativeMemoryFile(input, output)).rejects.toMatchObject({
        phase: "replay",
        lineNumber: 2,
        requestId: value.requestId,
        cause,
      });
      expect(create).toHaveBeenCalledTimes(1);
      await expect(readFile(output)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      create.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
