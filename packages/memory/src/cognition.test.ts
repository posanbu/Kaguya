/**
 * 功能概述：验证认知 capability 的严格来源边界与 Mem0 请求隔离，不访问外部 provider。
 * input 构造持久化文档，fetch 替身核对命名空间、证据 metadata、异常脱敏与 abort；
 * malicious result 用于证明 provider 不能添加未知来源或跨聊天范围文档；群聊多账号
 * 与私聊账号隔离分别验证，Mem0 请求中的说话者和原始文本必须保持一一对应。
 * 原生 replyTo 覆盖多说话者唯一匹配、窗口外/歧义/发送者不符、自身引用与伪造映射；
 * fetch 替身验证原生回复证据完整透传，深冻结测试保证 provider 无法修改原始输入或回复对象。
 */
import { describe, expect, it, vi } from "vitest";
import {
  Mem0CognitionProvider,
  cognitionInputSchema,
  freezeCognitionInput,
  awaitWithSignal,
  resolveCognitionReplyTarget,
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
      validateCognitionInput({
        ...input,
        sourceInformationIds: ["source", "source"],
      }),
    ).toThrow("Invalid cognition source order");
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
            address: {
              ...document.address,
              destination: { kind: "group", groupId: "other" },
            },
          },
        ],
        sourceInformationIds: ["source", "second"],
      }),
    ).toThrow("Mixed cognition scope");
    expect(validateCognitionResult({ facts: [] }, input)).toEqual({
      facts: [],
    });
  });
  it("keeps multiple group speakers but rejects mixed private accounts and namespaces", () => {
    const second = {
      ...document,
      sourceInformationId: "second",
      content: "那是以前，我现在不喝咖啡",
      address: { ...document.address, accountId: "other" },
    };
    const conversation = {
      ...input,
      documents: [document, second],
      sourceInformationIds: ["source", "second"],
    };
    expect(() => validateCognitionInput(conversation)).not.toThrow();
    expect(() =>
      validateCognitionResult(
        {
          facts: [
            { text: "逆序证据", sourceInformationIds: ["second", "source"] },
          ],
        },
        conversation,
      ),
    ).toThrow("Invalid cognition evidence");
    for (const address of [
      { adapterId: "other-adapter" },
      { platform: "other-platform" },
    ]) {
      expect(() =>
        validateCognitionInput({
          ...conversation,
          documents: [
            document,
            { ...second, address: { ...second.address, ...address } },
          ],
        }),
      ).toThrow("Mixed cognition scope");
    }
    expect(() =>
      validateCognitionInput({
        ...conversation,
        documents: conversation.documents.map((doc) => ({
          ...doc,
          address: {
            ...doc.address,
            destination: { kind: "private" as const, userId: "user" },
          },
        })),
      }),
    ).toThrow("Mixed cognition scope");
  });
  it("resolves a native reply using the target sender across multiple group speakers", () => {
    const other = {
      ...document,
      sourceInformationId: "other-source",
      address: { ...document.address, accountId: "other-speaker" },
    };
    const reply = {
      ...document,
      sourceInformationId: "reply-source",
      address: {
        ...document.address,
        accountId: "reply-speaker",
        platformMessageId: "reply-message",
      },
      replyTo: {
        platformMessageId: "message",
        senderId: "user",
        sourceInformationId: "source",
      },
    };
    const documents = [document, other, reply];
    expect(
      resolveCognitionReplyTarget(documents, "reply-source", reply.replyTo),
    ).toBe("source");
    expect(() =>
      validateCognitionInput({
        ...input,
        documents,
        sourceInformationIds: documents.map((doc) => doc.sourceInformationId),
      }),
    ).not.toThrow();
  });
  it.each([
    { name: "absent", platformMessageId: "outside-window" },
    { name: "ambiguous", platformMessageId: "message" },
    {
      name: "mismatched sender",
      platformMessageId: "message",
      senderId: "unknown",
    },
    { name: "self", platformMessageId: "reply-message" },
  ])(
    "retains unresolved $name reply evidence without inventing a target",
    (nativeReply) => {
      const { name: _name, ...replyTo } = nativeReply;
      const reply = {
        ...document,
        sourceInformationId: "reply-source",
        address: { ...document.address, platformMessageId: "reply-message" },
        replyTo: { ...replyTo, sourceInformationId: null },
      };
      const duplicate = {
        ...document,
        sourceInformationId: "duplicate-source",
      };
      const documents = [document, duplicate, reply];
      expect(
        resolveCognitionReplyTarget(documents, "reply-source", replyTo),
      ).toBeNull();
      expect(() =>
        validateCognitionInput({
          ...input,
          documents,
          sourceInformationIds: documents.map((doc) => doc.sourceInformationId),
        }),
      ).not.toThrow();
    },
  );
  it.each(["forged-source", "reply-source", null])(
    "rejects fabricated or omitted uniquely resolvable reply mapping %s",
    (sourceInformationId) => {
      const reply = {
        ...document,
        sourceInformationId: "reply-source",
        address: { ...document.address, platformMessageId: "reply-message" },
        replyTo: { platformMessageId: "message", sourceInformationId },
      };
      expect(() =>
        validateCognitionInput({
          ...input,
          documents: [document, reply],
          sourceInformationIds: ["source", "reply-source"],
        }),
      ).toThrow("Invalid cognition evidence");
    },
  );
  it("rejects reply fields outside the native evidence contract", () => {
    for (const replyTo of [
      { platformMessageId: " ", sourceInformationId: null },
      {
        platformMessageId: "missing",
        senderId: " ",
        sourceInformationId: null,
      },
      {
        platformMessageId: "missing",
        sourceInformationId: null,
        person: "guessed",
      },
      { platformMessageId: "missing" },
    ]) {
      expect(() =>
        cognitionInputSchema.parse({
          ...input,
          documents: [{ ...document, replyTo }],
        }),
      ).toThrow();
    }
  });
  it("isolates requests in Mem0 and attaches only the supplied evidence", async () => {
    let namespace = "";
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        namespace = body.user_id;
        expect(body.messages).toEqual([
          {
            role: "user",
            content: JSON.stringify({
              sourceInformationId: "source",
              platformMessageId: "message",
              occurredAt: document.occurredAt,
              speaker: {
                platform: "qq",
                adapterId: "qq.main",
                accountId: "user",
              },
              destination: { kind: "group", groupId: "group" },
              text: "喜欢月亮",
            }),
          },
        ]);
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
  it("sends each group speaker with their own statement instead of one shared user voice", async () => {
    const second = {
      ...document,
      sourceInformationId: "second",
      content: "他以前喜欢咖啡",
      address: {
        ...document.address,
        accountId: "speaker-b",
        platformMessageId: "reply-message",
      },
      replyTo: {
        platformMessageId: "message",
        senderId: "user",
        sourceInformationId: "source",
      },
    };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const messages = body.messages.map((message: { content: string }) =>
          JSON.parse(message.content),
        );
        expect(
          messages.map(
            (message: { speaker: { accountId: string }; text: string }) => [
              message.speaker.accountId,
              message.text,
            ],
          ),
        ).toEqual([
          ["user", "喜欢月亮"],
          ["speaker-b", "他以前喜欢咖啡"],
        ]);
        expect(messages[0]).toHaveProperty("platformMessageId", "message");
        expect(messages[0]).not.toHaveProperty("replyTo");
        expect(messages[1]).toMatchObject({
          sourceInformationId: "second",
          platformMessageId: "reply-message",
          replyTo: {
            platformMessageId: "message",
            senderId: "user",
            sourceInformationId: "source",
          },
        });
        expect(body.metadata.sourceInformationIds).toEqual([
          "source",
          "second",
        ]);
      }
      return Response.json({ results: [] });
    });
    const provider = new Mem0CognitionProvider({
      baseUrl: "http://localhost:8000",
      apiKey: "test-only-placeholder",
      revision: "v1",
      fetch: fetcher,
    });
    await provider.evolve(
      {
        ...input,
        documents: [document, second],
        sourceInformationIds: ["source", "second"],
      },
      new AbortController().signal,
    );
  });
  it("sends unresolved native reply evidence to Mem0 with an explicit null target", async () => {
    const replyTo = {
      platformMessageId: "outside-window",
      senderId: "other",
      sourceInformationId: null,
    };
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(JSON.parse(body.messages[0].content)).toMatchObject({
          platformMessageId: "message",
          replyTo,
        });
      }
      return Response.json({ results: [] });
    });
    const provider = new Mem0CognitionProvider({
      baseUrl: "http://localhost:8000",
      apiKey: "test-only-placeholder",
      revision: "v1",
      fetch: fetcher,
    });
    await provider.evolve(
      { ...input, documents: [{ ...document, replyTo }] },
      new AbortController().signal,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    const replyTo = {
      platformMessageId: "outside-window",
      senderId: "other",
      sourceInformationId: null,
    };
    const original = { ...input, documents: [{ ...document, replyTo }] };
    const frozen = freezeCognitionInput(original);
    expect(Object.isFrozen(frozen.documents)).toBe(true);
    expect(Object.isFrozen(frozen.documents[0]!.address)).toBe(true);
    expect(Object.isFrozen(frozen.documents[0]!.replyTo)).toBe(true);
    expect(frozen.documents[0]!.replyTo).not.toBe(replyTo);
    expect(frozen.sourceInformationIds).not.toBe(input.sourceInformationIds);
    replyTo.platformMessageId = "changed-after-freeze";
    expect(frozen.documents[0]!.replyTo).toEqual({
      platformMessageId: "outside-window",
      senderId: "other",
      sourceInformationId: null,
    });
    expect(() => {
      frozen.documents[0]!.replyTo!.senderId = "tampered";
    }).toThrow(TypeError);
    expect(replyTo.senderId).toBe("other");
  });
});
