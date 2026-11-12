/**
 * 功能概述：验证回复节奏预览接入生产 Light/Heavy 编译器且不泄漏参考回复。
 * 主要职责：逐案例检查输入、编译来源、协议 schema、媒体缺失与固定模板哈希；
 * 改写参考与评分要求后检查候选 Prompt 不变，核对内置候选绑定实际组装输入并拒绝未知 caseId。
 * 代码库关系：直接加载 reply-rhythm-provider.cjs 与 assemble.cjs；依赖仓库构建包。
 * 输入输出与副作用：只读 default 模板与公开合成数据，fetch 设为拒绝式替身；无数据库或外部模型。
 * 异步入口均直接 await 编译 Promise，无固定 sleep、默认轮询或后台收尾等待。
 */
import { createRequire } from "node:module";
import { afterEach, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const Provider = require("./reply-rhythm-provider.cjs");
const { assemble } = require("../benchmarks/reply-rhythm/assemble.cjs");
const cases = require("../benchmarks/reply-rhythm/cases.json");
const candidates = require("../benchmarks/reply-rhythm/baseline-candidates.json");
afterEach(() => vi.unstubAllGlobals());
it.each(cases.map((item: { id: string }) => item.id))(
  "compiles %s using production components and zero network requests",
  async (caseId) => {
    const fetch = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", fetch);
    const response = await new Provider({}).callApi("", { vars: { caseId } });
    const preview = JSON.parse(response.output);
    expect(preview.caseId).toBe(caseId);
    const matchingCandidates = candidates.filter(
      (candidate: { caseId: string }) => candidate.caseId === caseId,
    );
    expect(matchingCandidates).toHaveLength(2);
    for (const candidate of matchingCandidates)
      expect(candidate.inputSha256).toBe(preview.inputSha256);
    expect(preview.networkRequests).toBe(0);
    expect(preview.requests.light.compiler).toMatch(/router\/light.ts$/);
    expect(preview.requests.heavy.compiler).toMatch(
      /heavy\/message-prompt.ts$/,
    );
    expect(preview.assembly).toBe(
      "production-compilers/default-templates/memory-off",
    );
    for (const request of [preview.requests.light, preview.requests.heavy]) {
      expect(request.promptSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(request.compilerSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        request.variables.some(
          (value: { name: string }) => value.name === "json_schema",
        ),
      ).toBe(true);
      expect(request.prompt).not.toContain("LEGACY_COPIED_BODY");
      const item = cases.find((entry: { id: string }) => entry.id === caseId);
      for (const message of item.input.messages)
        expect(request.prompt).toContain(message.text);
      if (caseId === "missing-media")
        expect(request.prompt).toContain("媒体内容缺失：image");
    }
    expect(fetch).not.toHaveBeenCalled();
  },
);
it("keeps reference replies and rubric changes outside both candidate prompts", async () => {
  const before = await assemble(cases[0]);
  const revised = structuredClone(cases[0]);
  revised.reference.text = "REFERENCE_REPLY_SENTINEL";
  revised.requiredAnswers[0].description = "RUBRIC_SENTINEL";
  const after = await assemble(revised);
  expect(after.requests).toEqual(before.requests);
  expect(after.inputSha256).toBe(before.inputSha256);
  expect(JSON.stringify(after)).not.toContain("REFERENCE_REPLY_SENTINEL");
  expect(JSON.stringify(after)).not.toContain("RUBRIC_SENTINEL");
});
it("rejects an unknown case before assembly", async () => {
  await expect(
    new Provider({}).callApi("", { vars: { caseId: "unknown" } }),
  ).rejects.toThrow("unknown reply rhythm case");
});
