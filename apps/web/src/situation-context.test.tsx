import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { situationRequestContext } from "./situation-context.js";
import {
  PersonBackground,
  SituationContextFab,
  SituationContextSummary,
} from "./SituationContext.js";

function request(
  taskId: string,
  variables: Record<string, string>,
  promptText = "冻结规则\n当前时间：FROZEN_TIME\n本轮消息",
) {
  return {
    taskId,
    prompt: {
      kind: taskId === "agent.light.decide" ? "route" : "message",
      text: promptText,
      templateId: "saved.template",
      templates: [{ name: "main", content: "未来模板不应重新渲染" }],
      variables: Object.entries(variables).map(([name, content]) => ({
        name,
        content,
        informationIds: [],
      })),
    },
  };
}
const decision = {
  attempt: 0,
  totalWaitBudget: 3,
  availableActions: ["message", "wait", "silent"],
  backlog: {
    isBacklog: false,
    oldestInputAgeMs: 33939,
    newestInputAgeMs: 23939,
    thresholdMs: 120000,
  },
};
const conversation = {
  background: {
    name: "冻结群名",
    scope: "group",
    participants: [
      {
        name: "冻结姓名",
        label: "speaker:1",
        relation: "speaker",
        identityStatus: "complete",
      },
    ],
  },
  resolution: {
    status: "available",
    targets: [
      { name: "当前群", kind: "group", status: "resolved" },
      { name: "其他群", kind: "group", status: "unauthorized" },
    ],
  },
};

describe("saved situation request context", () => {
  it("reads Light's frozen routing, zero wait count and backlog without inferring defaults", () => {
    const result = situationRequestContext(
      request("agent.light.decide", {
        current_time: "FROZEN_TIME",
        platform_policy: "冻结 QQ 策略",
        conversation: JSON.stringify(conversation),
        bootstrap: JSON.stringify({ mode: "established" }),
        context_bootstrap: JSON.stringify({
          mode: "contextual",
          historyCount: 30,
        }),
        decision_state: JSON.stringify(decision),
      }),
    );
    expect(result).toMatchObject({
      behavior: "冻结规则",
      platform: "冻结 QQ 策略",
      bootstrap: "contextual",
      historyCount: 30,
      attempt: 0,
      waitBudget: 3,
      canWait: true,
      resolution: "available",
      backlog: {
        active: false,
        oldestMs: 33939,
        newestMs: 23939,
        thresholdMs: 120000,
      },
    });
    expect(result?.targets.map((target) => target.status)).toEqual([
      "resolved",
      "unauthorized",
    ]);
    expect(result?.background?.participants[0]?.name).toBe("冻结姓名");
  });
  it("uses Heavy's saved policy and wrapped bootstrap, with its own conversation background", () => {
    const result = situationRequestContext(
      request("agent.heavy.respond", {
        behavior_policy: "原请求行为规则",
        platform_style: "原请求平台策略",
        bootstrap: '【上下文可靠性】\n{"mode":"warming"}\n后续说明',
        conversation_background: JSON.stringify(conversation.background),
      }),
    );
    expect(result).toMatchObject({
      behavior: "原请求行为规则",
      platform: "原请求平台策略",
      bootstrap: null,
      background: { name: "冻结群名" },
      resolution: null,
      attempt: null,
      waitBudget: null,
      backlog: null,
    });
  });
  it("keeps missing or malformed state unknown rather than showing zero budget or no backlog", () => {
    const result = situationRequestContext(
      request("agent.light.decide", {
        decision_state: "not-json",
        bootstrap: "not-json",
        conversation: "[]",
      }),
    );
    expect(result).toMatchObject({
      behavior: null,
      background: null,
      bootstrap: null,
      resolution: null,
      attempt: null,
      waitBudget: null,
      canWait: null,
      backlog: null,
    });
    expect(
      situationRequestContext({ prompt: { text: "incomplete" } }),
    ).toBeNull();
  });
  it("distinguishes exhausted waiting from a zero attempt", () => {
    const result = situationRequestContext(
      request("agent.light.decide", {
        decision_state: JSON.stringify({
          ...decision,
          attempt: 3,
          availableActions: ["message", "silent"],
        }),
      }),
    );
    expect(result).toMatchObject({ attempt: 3, waitBudget: 3, canWait: false });
  });
  it("summarizes parsed candidates without treating unauthorized targets as resolved", () => {
    const context = situationRequestContext(
      request("agent.light.decide", {
        conversation: JSON.stringify(conversation),
        bootstrap: '{"mode":"established"}',
        decision_state: JSON.stringify(decision),
      }),
    );
    const html = renderToStaticMarkup(
      <SituationContextSummary
        context={context}
        loading={false}
        error={null}
        hasRequest
      />,
    );
    expect(html).toContain("2 候选 · 1 已解析");
    expect(html).toContain("已用 0/3");
    expect(html).toContain("无 · 最旧 34秒");
    expect(html).toContain("其他群 · 未授权");
    const absent = renderToStaticMarkup(
      <SituationContextSummary
        context={null}
        loading={false}
        error={null}
        hasRequest
      />,
    );
    expect(absent).toContain("未记录");
    expect(absent).not.toContain("已用 0/0");
  });
  it("keeps details collapsed by default and escapes untrusted participant text", () => {
    const context = situationRequestContext(
      request("agent.light.decide", {
        conversation: JSON.stringify({
          ...conversation,
          background: {
            ...conversation.background,
            name: "<script>doNotRun()</script>",
          },
        }),
      }),
    );
    const props = {
      context,
      loading: false,
      error: null,
      tick: "TICK −2",
      tier: "light" as const,
      tiers: ["light" as const],
      onOpenChange: () => {},
      onTierChange: () => {},
    };
    const closed = renderToStaticMarkup(
      <SituationContextFab {...props} open={false} />,
    );
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain('class="situation-context-panel"');
    const open = renderToStaticMarkup(<SituationContextFab {...props} open />);
    expect(open).toContain("&lt;script&gt;doNotRun()&lt;/script&gt;");
    expect(open).not.toContain("<script>");
    expect(open).toContain("TICK −2");
  });
});

describe("saved person context", () => {
  const summary = {
    id: "00000000-0000-4000-8000-000000000001",
    content: "自述叫小林。此前在本群发过言，现有来源未记录相互介绍。",
    metadata: {
      system: "native-v1",
      kind: "person",
      ownerId: "person:lin",
      scope: "group:one",
      level: 0,
      revision: 3,
      status: "active",
      locked: false,
      sourceIds: ["source-3"],
      aliases: [],
      tags: [],
      occurredAt: "2026-10-21T00:00:00Z",
    },
  };
  const memory = {
    version: 1,
    status: "enabled",
    frozenAt: "2026-10-21T00:01:00Z",
    scope: "group:one",
    owners: ["person:lin"],
    people: [],
    fixed: [summary],
    recalled: [],
    degraded: [],
    budget: { dynamicCharacters: 0, omittedNodeIds: [] },
  };
  it("associates exact summaries by owner, preserves raw prompt and freezes versions", () => {
    const background = {
      ...conversation.background,
      participants: [
        {
          ...conversation.background.participants[0],
          name: "同名",
          ownerId: "person:lin",
          extraEvidence: "保留原字段",
        },
        {
          ...conversation.background.participants[0],
          name: "同名",
          label: "person-2",
          ownerId: "person:other",
        },
      ],
    };
    const raw = JSON.stringify({ background });
    const context = situationRequestContext(
      request("agent.light.decide", {
        conversation: raw,
        native_memory: JSON.stringify(memory),
      }),
    )!;
    expect(context.backgroundRaw).toBe(raw);
    expect(context.background!.participants[0]!.raw).toContain("保留原字段");
    const html = renderToStaticMarkup(<PersonBackground context={context} />);
    expect(html).toContain(summary.content);
    expect(html).toContain("版本 3");
    expect(html).toContain("source-3");
    expect(html).toContain("此请求没有适用的固定摘要");
    expect(html).not.toContain("身份已解析");
    expect(html.match(/此前在本群发过言/g)).toHaveLength(1);
    expect(context.memory!.fixed[0]!.metadata.revision).toBe(3);
  });
  it.each([
    [undefined, "此请求未记录固定记忆"],
    ["invalid-json", "此请求的记忆快照无法解析"],
    [
      JSON.stringify({ ...memory, status: "disabled", fixed: [] }),
      "此请求的 Memory 已关闭",
    ],
    [JSON.stringify({ ...memory, fixed: [] }), "此请求没有适用的固定摘要"],
  ])(
    "distinguishes missing, invalid, disabled and empty memory",
    (value, message) => {
      const context = situationRequestContext(
        request("agent.light.decide", {
          conversation: JSON.stringify({
            background: {
              ...conversation.background,
              participants: [
                {
                  ...conversation.background.participants[0],
                  ownerId: "person:lin",
                },
              ],
            },
          }),
          ...(value ? { native_memory: value } : {}),
        }),
      )!;
      expect(
        renderToStaticMarkup(<PersonBackground context={context} />),
      ).toContain(message);
    },
  );
});
