/**
 * 功能概述：检验记忆录入的反馈契约和安全渲染，不把提交或澄清误报为入库。
 * 主要职责：真实 JobResult 覆盖处理中、歧义、失败重试、来源和部分完成；API 用实际共享 DTO 校验。
 * 代码库关系：静态渲染补充浏览器交互检查，服务端集成测试负责真实持久化与新会话召回。
 * 输入输出与副作用：使用合成输入和临时 fetch 替身，不连接外网、不保存真实 Token。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  memoryIngestionJobSchema,
  type MemoryIngestionJob,
} from "@kaguya/schema";
import { JobResult } from "./MemoryIngestion.js";
import { requestMemoryIngestion } from "./memory-ingestion-api.js";
const job = memoryIngestionJobSchema.parse({
  requestId: "a9f2fb21-fb2c-43c2-bc3b-671f2d48e2e5",
  sessionId: "510d9011-d810-4a78-b1ab-c213e5f44ea4",
  scopeInformationId: "memory:access:global",
  sourceType: "user_statement",
  text: "<script>unsafe()</script>",
  contractVersion: 2,
  submitter: "webui:management",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  status: "queued",
  attempt: 0,
  questions: [],
  ambiguities: [],
  results: [],
  errorCode: null,
});
const render = (patch: Partial<MemoryIngestionJob>) =>
  renderToStaticMarkup(
    <JobResult
      job={{ ...job, ...patch }}
      busy={false}
      onRetry={() => {}}
      resolutions={{}}
      onResolve={() => {}}
      allowResolution
    />,
  );
afterEach(() => vi.unstubAllGlobals());
describe("记忆录入结果", () => {
  it("不把排队、处理中或澄清写成已入库", () => {
    for (const status of ["queued", "processing", "clarification"] as const)
      expect(render({ status })).not.toContain("已入库");
    expect(
      render({
        status: "partial",
        results: [
          { status: "unprocessed", label: "<script>unsafe()</script>" },
        ],
      }),
    ).toContain("部分完成");
    expect(
      render({
        status: "partial",
        results: [
          { status: "unprocessed", label: "<script>unsafe()</script>" },
        ],
      }),
    ).not.toContain("<script>");
  });
  it("提供明确的身份选项、来源和失败恢复", () => {
    expect(
      render({
        status: "clarification",
        ambiguities: [
          {
            label: "小林",
            candidates: [
              {
                label: "小林",
                entityInformationId: "person-a",
                description: "群里的小林",
              },
              {
                label: "小林",
                entityInformationId: "person-b",
                description: "角色小林",
              },
            ],
          },
        ],
      }).match(/type="radio"/g),
    ).toHaveLength(2);
    expect(
      render({ status: "failed", errorCode: "model_retryable" }),
    ).toContain("重试这一条");
    expect(
      render({ status: "failed", errorCode: "incompatible_contract" }),
    ).not.toContain("重试这一条");
    expect(
      render({
        status: "succeeded",
        results: [
          {
            status: "revised",
            label: "喜好已修订",
            sourceInformationId: "original",
            claimId: "new",
            supersedesClaimId: "old",
          },
        ],
      }),
    ).toContain("修订自");
  });
  it("复用提交 ID，并拒绝未通过 DTO 校验的响应", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: job }), { status: 202 }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(
      await requestMemoryIngestion(
        "synthetic-token",
        "jobs",
        memoryIngestionJobSchema,
        { body: { requestId: job.requestId } },
      ),
    ).toEqual(job);
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
      requestId: job.requestId,
    });
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { status: "succeeded" } })),
    );
    await expect(
      requestMemoryIngestion(
        "synthetic-token",
        "jobs",
        memoryIngestionJobSchema,
      ),
    ).rejects.toThrow();
  });
});
