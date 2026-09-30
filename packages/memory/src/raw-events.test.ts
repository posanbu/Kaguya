import { describe, expect, it } from "vitest";
import { renderRawEvent, type RawEvent, type RawScope } from "./raw-events.js";
const scope: RawScope = {
  platform: "qq",
  adapterId: "main",
  destination: { kind: "group", groupId: "g" },
};
function atom(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  references: RawEvent["references"] = [],
  eventScope: RawScope | null = scope,
): RawEvent {
  return {
    informationId: id,
    kind,
    payload,
    references,
    scope: eventScope,
    occurredAt: "2026-09-01T00:00:00.000Z",
    position: 1,
  };
}
const evidence = (...events: RawEvent[]) =>
  new Map(events.map((event) => [event.informationId, event]));
const link = (relation: string, informationId: string) => ({
  relation,
  informationId,
});

describe("raw Memory event-specific descriptions", () => {
  it("marks only the supplied unread inbound and keeps the original reply relation", () => {
    const incoming = atom("in", "core.message.inbound.text", {
      text: "原文",
      source: {
        senderId: "u",
        selfId: "bot",
        platformMessageId: "new",
        sender: { nickname: "小明" },
        mentions: [{ kind: "user", id: "bot" }],
        replyTo: { platformMessageId: "old", senderId: "bot" },
      },
    });
    expect(renderRawEvent(incoming, evidence(), true)?.text).toContain(
      "【未读】小明",
    );
    expect(renderRawEvent(incoming, evidence(), true)?.text).toContain(
      "原生回复消息 old",
    );
    expect(renderRawEvent(incoming, evidence(), true)?.text).toContain(
      "原生消息 ID new",
    );
    expect(renderRawEvent(incoming, evidence(), true)?.text).toContain(
      "明确提及当前账号；回复当前账号",
    );
    expect(renderRawEvent(incoming, evidence())?.text).not.toContain("未读");
  });
  it.each(["core.delivery.delivered", "core.delivery.failed"])(
    "requires the entire delivery evidence chain for %s",
    (kind) => {
      const assistant = atom("a", "core.message.assistant.text", {
        text: "正文",
      });
      const request = atom(
        "r",
        "core.delivery.requested",
        {
          message: { kind: "text", text: "正文" },
          destination: scope.destination,
        },
        [link("core:caused-by", "a")],
      );
      const result = atom(
        "d",
        kind,
        kind.endsWith("delivered")
          ? { ok: true, platformMessageId: "receipt" }
          : { ok: false, error: "transport-error" },
        [link("core:status-of", "r"), link("core:caused-by", "r")],
      );
      expect(
        renderRawEvent(result, evidence(request, assistant)),
      ).toMatchObject({ informationIds: ["d", "r", "a"] });
      expect(
        renderRawEvent(result, evidence(request, assistant))?.text,
      ).toContain("正文");
      expect(renderRawEvent(result, evidence(request))).toBeUndefined();
      if (kind.endsWith("failed")) {
        expect(
          renderRawEvent(result, evidence(request, assistant))?.text,
        ).toContain("未被确认收到");
        expect(
          renderRawEvent(result, evidence(request, assistant))?.text,
        ).not.toContain("已发送");
      } else
        expect(
          renderRawEvent(result, evidence(request, assistant))?.text,
        ).toContain("已发送");
    },
  );
  it("describes scope and account bindings as explicit identity records", () => {
    const entity = atom("scope", "memory.identity.chat.scope.entity", {
      platform: "qq",
      adapterId: "main",
      scopeMode: "canonical",
      destination: scope.destination,
    });
    const binding = atom("binding", "memory.identity.chat.scope.binding", {}, [
      link("core:binds", "scope"),
    ]);
    expect(renderRawEvent(binding, evidence(entity))?.text).toContain(
      "身份归属记录",
    );
    expect(renderRawEvent(binding, evidence())).toBeUndefined();
    const account = atom(
      "account",
      "memory.identity.platform.account.entity",
      { platform: "qq", adapterId: "main", accountId: "u" },
      [],
      null,
    );
    const person = atom(
      "person",
      "memory.identity.person.entity",
      {},
      [],
      null,
    );
    const accountBinding = atom(
      "ab",
      "memory.identity.platform.account.binding",
      { personInformationId: "person" },
      [link("core:binds", "account")],
      null,
    );
    expect(
      renderRawEvent(accountBinding, evidence(account, person))?.text,
    ).toContain("不由昵称推断");
    expect(renderRawEvent(accountBinding, evidence(account))).toBeUndefined();
  });
  it("keeps saved profile and derived memory status precise", () => {
    const source = atom("in", "core.message.inbound.text", { text: "原文" });
    const person = atom(
      "person",
      "memory.identity.person.entity",
      {},
      [],
      null,
    );
    const profile = atom(
      "p",
      "memory.identity.person.profile.revision",
      {
        personInformationId: "person",
        revision: 2,
        sections: {
          stableFacts: [{ text: "喜欢月亮", evidenceInformationIds: ["in"] }],
        },
        metadata: { primaryName: "小明", knownStatus: "known", aliases: [] },
      },
      [link("memory:profile-of", "person")],
      null,
    );
    expect(renderRawEvent(profile, evidence(person, source))?.text).toContain(
      "不代表当前已生效",
    );
    expect(
      renderRawEvent(profile, evidence(person, source))?.informationIds,
    ).toEqual(["p", "person", "in"]);
    expect(renderRawEvent(profile, evidence(person))).toBeUndefined();
    const memory = atom("m", "memory.text", { text: "喜欢月亮" }, [
      link("core:uses-context", "in"),
    ]);
    expect(renderRawEvent(memory, evidence(source))?.text).toContain(
      "派生记忆陈述",
    );
    expect(renderRawEvent(memory, evidence())).toBeUndefined();
  });
  it("includes only successful expression habits with cited evidence", () => {
    const entity = atom(
      "scope",
      "memory.identity.chat.scope.entity",
      {},
      [],
      scope,
    );
    const source = atom("in", "core.message.inbound.text", { text: "原文" });
    const habits = [
      {
        situation: "解释问题",
        style: "短句直说",
        sourceInformationIds: ["in"],
      },
    ];
    const result = atom(
      "learn",
      "memory.expression.learning.completed",
      { status: "completed", scopeInformationId: "scope", habits },
      [link("core:uses-context", "in")],
    );
    expect(renderRawEvent(result, evidence(entity, source))?.text).toContain(
      "解释问题 → 短句直说",
    );
    expect(
      renderRawEvent(
        { ...result, payload: { ...result.payload, status: "failed" } },
        evidence(entity, source),
      ),
    ).toBeUndefined();
    expect(
      renderRawEvent(
        { ...result, payload: { ...result.payload, habits: [] } },
        evidence(entity, source),
      ),
    ).toBeUndefined();
  });
  it("does not promote an extracted snippet into a permanent conclusion", () => {
    const source = atom("in", "core.message.inbound.text", {
      text: "我喜欢月亮",
    });
    const candidate = atom(
      "c",
      "core.person.fact.candidate",
      { text: "我喜欢月亮" },
      [link("core:caused-by", "in")],
    );
    const request = atom("r", "core.model.task.requested", {
      sourceInformationId: "c",
    });
    const task = atom("t", "core.model.task.completed", {}, [
      link("core:status-of", "r"),
    ]);
    const fact = atom(
      "f",
      "core.person.fact.extracted",
      { name: "小明", fact: "喜欢月亮" },
      [link("core:caused-by", "t")],
    );
    expect(
      renderRawEvent(fact, evidence(source, candidate, request, task))?.text,
    ).toContain("尚非永久人物结论");
    expect(
      renderRawEvent(fact, evidence(candidate, request, task)),
    ).toBeUndefined();
    expect(
      renderRawEvent(
        { ...fact, payload: { fact: "不存在的事实" } },
        evidence(source, candidate, request, task),
      ),
    ).toBeUndefined();
  });
  it("does not render requests or arbitrary JSON", () => {
    expect(
      renderRawEvent(
        atom("r", "core.delivery.requested", { message: { text: "draft" } }),
        evidence(),
      ),
    ).toBeUndefined();
  });
});
