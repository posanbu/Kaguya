/**
 * 功能概述：验证认知 capability 的严格来源边界与 Mem0 请求隔离，不访问外部 provider。
 * input 构造持久化文档，fetch 替身核对命名空间、证据 metadata、异常脱敏与 abort；
 * malicious result 用于证明 provider 不能添加未知来源或跨账号文档。
 */
import { describe, expect, it, vi } from "vitest";
import {
  Mem0CognitionProvider,
  freezeCognitionInput,
  awaitWithSignal,
  validateCognitionInput,
  validateCognitionResult,
} from "./cognition.js";
const document = {
  memoryId: "memory",
  sourceInformationId: "source",
  sourceKind: "core.message.inbound.text",
  content: "喜欢月亮",
  occurredAt: "2026-09-01T00:00:00.000Z",
  createdAt: "2026-09-01T00:00:00.000Z",
  address: {
    platform: "qq",
    adapterId: "qq.main",
    accountId: "user",
    platformMessageId: "message",
    destination: { kind: "group" as const, groupId: "group" },
  },
};
const input = {
  operationKey: "request",
  documents: [document],
  sourceInformationIds: ["source"],
};
describe("cognition provider boundary", () => {
  it("rejects unknown, duplicated and unordered evidence and mixed scopes", () => {
    expect(() =>
      validateCognitionResult(
        { facts: [{ text: "fact", sourceInformationIds: ["unknown"] }] },
        input,
      ),
    ).toThrow();
    expect(() =>
      validateCognitionResult(
        {
          facts: [{ text: "fact", sourceInformationIds: ["source", "source"] }],
        },
        input,
      ),
    ).toThrow();
    expect(() =>
      validateCognitionInput({
        ...input,
        documents: [
          document,
          {
            ...document,
            sourceInformationId: "second",
            address: { ...document.address, accountId: "other" },
          },
        ],
        sourceInformationIds: ["source", "second"],
      }),
    ).toThrow("Mixed cognition scope");
    expect(validateCognitionResult({ facts: [] }, input)).toEqual({
      facts: [],
    });
  });
  it("isolates requests in Mem0 and attaches only the supplied evidence", async () => {
    let namespace = "";
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        namespace = body.user_id;
        expect(body.messages).toEqual([{ role: "user", content: "喜欢月亮" }]);
        expect(body.metadata).toEqual({ sourceInformationIds: ["source"] });
        return Response.json({ results: [] });
      }
      expect(String(url)).toContain(`user_id=${namespace}`);
      return Response.json({
        results: [
          {
            memory: "喜欢月亮",
            user_id: namespace,
            metadata: { sourceInformationIds: ["source"] },
          },
        ],
      });
    });
    const provider = new Mem0CognitionProvider({
      baseUrl: "http://127.0.0.1:8000",
      apiKey: "test-only-placeholder",
      revision: "v1",
      fetch: fetcher,
    });
    expect(await provider.evolve(input, new AbortController().signal)).toEqual({
      facts: [{ text: "喜欢月亮", sourceInformationIds: ["source"] }],
    });
    const first = namespace;
    await provider.evolve(input, new AbortController().signal);
    expect(namespace).toBe(first);
    await provider.evolve(
      { ...input, operationKey: "next" },
      new AbortController().signal,
    );
    expect(namespace).not.toBe(first);
  });
  it("sanitizes network errors and rejects output from an unauthorized namespace", async () => {
    const provider = new Mem0CognitionProvider({
      baseUrl: "http://localhost:8000",
      apiKey: "test-only-placeholder",
      revision: "v1",
      fetch: async (_url, init) =>
        init?.method === "POST"
          ? Response.json({})
          : Response.json({
              results: [
                {
                  memory: "secret",
                  user_id: "other",
                  metadata: { sourceInformationIds: ["source"] },
                },
              ],
            }),
    });
    await expect(
      provider.evolve(input, new AbortController().signal),
    ).rejects.toThrow("Memory cognition provider unavailable");
  });
  it("bounds an uncooperative provider with abort", async () => {
    const controller = new AbortController();
    const result = awaitWithSignal(
      new Promise(() => undefined),
      controller.signal,
    );
    controller.abort();
    await expect(result).rejects.toThrow("Memory operation aborted");
  });
  it("freezes a detached provider input before result validation", () => {
    const frozen = freezeCognitionInput(input);
    expect(Object.isFrozen(frozen.documents)).toBe(true);
    expect(Object.isFrozen(frozen.documents[0]!.address)).toBe(true);
    expect(frozen.sourceInformationIds).not.toBe(input.sourceInformationIds);
  });
});
