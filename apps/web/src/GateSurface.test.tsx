/**
 * 功能概述：验证注意力门控 Surface 的历史证据展示，避免把分数、等待建议或来源缺失解释成当前执行状态。
 * 主要职责：通过生产 ModuleSurface 分派静态渲染，覆盖硬门禁、直接唤醒、评分、预算、未知原因和读取状态；
 * 检查冻结上下文的红绿灯摘要默认收起，并把 scopeKey/asOf 留在技术追溯中。
 * 贡献图保留精确的正负数值、零值和缺失说明；原始原因仅放在技术追溯，避免正文重复判断结论。
 * 代码库关系：mock useInspection 返回经过 Schema 校验的目录和详情；复用真实 attention-gate 解释逻辑，
 * 不 mock 判定结果，不访问 Runtime、数据库、网络或现行配置。浏览器交互和响应式由另外的验收覆盖。
 * 输入输出与副作用：全部使用同步 SSR 与独立历史 fixture，检查用户可见说明和追溯入口；每例重置记录，
 * 不启动等待任务，不把 dueAt 作为活动预约，不把 attend 当作已经发送回复。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import {
  inspectionRecordPageSchema,
  inspectionSurfaceEntitySchema,
  moduleInspectionSurfaceSchema,
  type InspectionModule,
  type InspectionSurfaceEntity,
  type JsonValue,
} from "@kaguya/schema";
import { ModuleSurface } from "./ModuleSurface.js";

const fixture = vi.hoisted(() => ({
  page: {} as Record<string, unknown>,
  detail: {} as Record<string, unknown>,
}));
vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path: string | undefined) =>
    path?.includes("/entities/") ? fixture.detail : fixture.page,
}));

const module = {
  definitionId: "agent.attention.arousal",
  inspection: {
    mechanism: ["先检查硬门禁，再检查直接关注规则、评分和等待次数预算。"],
    views: [],
    surface: moduleInspectionSurfaceSchema.parse({
      version: 1,
      id: "gates",
      title: "注意力门控",
      layout: { type: "master-detail", areas: ["main"] },
      components: [
        {
          id: "gates",
          type: "record-browser",
          presentation: "attention-gate",
          area: "main",
          viewId: "gates",
          recordKind: "agent.attention.arousal.completed",
          titleField: "text",
          searchFields: ["text", "source"],
          fields: [{ path: "outcome", label: "结果" }],
          status: {
            field: "outcome",
            options: [
              { value: "attend", label: "放行至规划" },
              { value: "defer", label: "延后观察" },
              { value: "ignore", label: "本次忽略" },
            ],
          },
          labels: {
            directory: "评估记录",
            search: "会话或输入",
            placeholder: "输入、会话或账号",
            empty: "尚无注意力评估记录",
            mechanism: "门控如何判断",
          },
          relations: [
            {
              id: "context",
              title: "冻结上下文",
              viewId: "gates",
              kinds: ["agent.turn.context.completed"],
              reference: "core:caused-by",
              direction: "forward",
              presentation: "field-grid",
              fields: [{ path: "safe", label: "安全检查" }],
              empty: "关联上下文不可用",
              limit: 1,
            },
          ],
        },
      ],
    }),
  },
} as unknown as InspectionModule;

function record(
  values: Record<string, JsonValue>,
  sections: InspectionSurfaceEntity["sections"] = [],
) {
  const entity = {
    entityId: "gate-1",
    entityKey: "gate-1",
    title: "请看看这个实验方案",
    subtitle: "",
    occurredAt: "2026-09-19T07:42:00Z",
    fields: Object.entries(values).map(([path, value]) => ({
      path,
      label: path,
      value,
    })),
  };
  fixture.page = {
    data: inspectionRecordPageSchema.parse({
      version: 1,
      surfaceId: "gates",
      items: [entity],
      nextCursor: null,
    }),
  };
  fixture.detail = {
    data: inspectionSurfaceEntitySchema.parse({
      version: 1,
      surfaceId: "gates",
      entity,
      sections,
    }),
  };
}

function contextSection(
  values: Record<string, JsonValue>,
): InspectionSurfaceEntity["sections"] {
  return [
    {
      id: "context",
      title: "冻结上下文",
      presentation: "field-grid",
      items: [
        {
          id: "context-1",
          occurredAt: "2026-09-19T07:41:00Z",
          fields: Object.entries(values).map(([path, value]) => ({
            path,
            label: path,
            value,
          })),
        },
      ],
    },
  ];
}

const render = () =>
  renderToStaticMarkup(
    <ModuleSurface
      module={module}
      token="never-render-token"
      revision={0}
      DetailComponent={() => <p>来源详情</p>}
    />,
  );

beforeEach(() => {
  record({
    outcome: "attend",
    reasonCodes: ["score-threshold-met"],
    score: 84,
    threshold: 80,
    source: {
      platform: "qq",
      destination: { kind: "group", groupId: "group-42" },
    },
  });
});

it("keeps a high-score hard gate as ignored and shows its score only as a reference", () => {
  record({
    outcome: "ignore",
    reasonCodes: ["muted", "unsafe"],
    score: 99,
    threshold: 80,
  });
  const html = render();
  expect(html).toContain("本次命中硬门禁并忽略");
  expect(html).toContain("已静音（muted）");
  expect(html).toContain("安全检查未通过（unsafe）");
  expect(html).toContain('aria-label="参考评分"');
  expect(html).not.toContain('aria-label="评分依据"');
  expect(html).not.toContain("达到当时阈值");
  const path = html.match(/<ol class="gate-path"[\s\S]*?<\/ol>/)?.[0];
  expect(path).toContain("命中拦截条件");
  expect(path).not.toContain("评分阈值");
});

it("keeps raw reasons in technical details without repeating them in the decision body", () => {
  record({ outcome: "ignore", reasonCodes: ["muted"] });
  const html = render();
  const technical = html.match(
    /<details class="gate-technical">[\s\S]*?<\/details>/,
  )?.[0];
  expect(technical).toContain("已静音（muted）");
  const body = html.replace(technical ?? "", "");
  expect(body).toMatch(/<h3[^>]*>已静音，本次输入被忽略<\/h3>/);
  expect(body).not.toContain("记录原因");
  expect(body).not.toContain("（muted）");
});

it("shows low-score direct passage without treating it as a sent reply or failed score decision", () => {
  record({
    outcome: "attend",
    reasonCodes: ["mentioned-self", "named-self"],
    score: 0,
    threshold: 80,
  });
  const html = render();
  expect(html).toContain("本次由直接唤醒分支放行至规划");
  expect(html).toContain("mentioned-self");
  expect(html).toContain("named-self");
  expect(html).toContain("不代表对应配置均已开启");
  expect(html).toContain("是否回复仍由后续规划");
  expect(html).toContain('aria-label="参考评分"');
  expect(html).not.toContain('aria-label="评分依据"');
  expect(html).not.toContain("低于阈值 80 分");
  expect(html).not.toContain("已回复");
});

it("shows recorded score evidence, conversation and bounded list scope for a score-based passage", () => {
  const html = render();
  expect(html).toMatch(/<h3[^>]*>评分达到当时阈值<\/h3>/);
  expect(html).toContain("当时分数达到阈值，放行至规划");
  expect(html).toContain('aria-label="评分依据"');
  expect(html).toContain("qq · 群聊 · group-42");
  expect(html).toContain("本页 1 条");
  expect(html).toContain("非全库统计");
  expect(html).toContain("打开评估原始记录");
  expect(html).not.toContain("never-render-token");
});

it("pairs contribution graphics with exact signed values and renders zero without a sign", () => {
  record({
    outcome: "defer",
    reasonCodes: ["score-below-threshold"],
    score: 13,
    threshold: 80,
    components: {
      relevance: 20,
      content: -7.25,
      pressure: 0,
      recentPresencePenalty: -0,
      preFrequencyScore: 12.75,
      frequencyFactor: 1,
    },
  });
  const html = render();
  const parts =
    html.match(/<dl class="gate-score-parts">[\s\S]*?<\/dl>/)?.[0] ?? "";
  for (const [label, expected] of [
    ["相关性", "+20"],
    ["内容", "-7.25"],
    ["消息压力", "0"],
    ["近期在场惩罚", "0"],
  ]) {
    const row = parts.match(
      new RegExp(
        `<dt><span>${label}</span>[\\s\\S]*?</dt><dd>([\\s\\S]*?)</dd>`,
      ),
    )?.[1];
    expect(row).toBeDefined();
    expect(row).toContain('aria-hidden="true"');
    expect(row?.replace(/<[^>]*>/g, "").replace(/−/g, "-")).toBe(expected);
  }
  expect(html).toMatch(/<strong>13<small> 分<\/small><\/strong>/);
});

it("keeps missing contributions absent while showing recorded penalties as negative", () => {
  record({
    outcome: "defer",
    reasonCodes: ["score-below-threshold"],
    components: { content: -5, pressure: null, recentPresencePenalty: 3 },
  });
  const html = render();
  const parts =
    html.match(/<dl class="gate-score-parts">[\s\S]*?<\/dl>/)?.[0] ?? "";
  for (const [label, expected] of [
    ["相关性", "未记录"],
    ["内容", "-5"],
    ["消息压力", "未记录"],
    ["近期在场惩罚", "-3"],
  ]) {
    const row = parts.match(
      new RegExp(
        `<dt><span>${label}</span>[\\s\\S]*?</dt><dd>([\\s\\S]*?)</dd>`,
      ),
    )?.[1];
    expect(row?.replace(/<[^>]*>/g, "").replace(/−/g, "-")).toBe(expected);
  }
});

it.each([
  ["defer", "score-below-threshold", 1, "仍有等待余量"],
  ["ignore", "wait-budget-exhausted", 3, "等待次数预算已用尽"],
])(
  "explains %s using wait counts and keeps dueAt historical",
  (outcome, reason, attempt, message) => {
    record({
      outcome,
      reasonCodes: [reason],
      score: 35,
      threshold: 80,
      attempt,
      totalWaitBudget: 3,
      dueAt: "2020-01-01T00:00:00Z",
    });
    const html = render();
    expect(html).toContain(message);
    expect(html).toContain("等待次数 / 预算上限");
    expect(html).toContain(`${attempt} / 3 次`);
    expect(html).toContain("建议复查时间");
    expect(html).toContain("不代表当前仍有待执行的预约");
    expect(html).toContain('aria-label="评分依据"');
    expect(html).not.toContain("倒计时");
  },
);

it("leaves absent scores and context visibly unrecorded without filling zeros or source actions", () => {
  record({ outcome: "attend", reasonCodes: ["private-conversation"] });
  const html = render();
  expect(html).toContain("本次由直接会话分支放行至规划");
  expect(html).toContain("关联上下文不可用");
  expect(html).not.toContain("查看来源");
  const score = html.match(
    /<div class="gate-score-total">[\s\S]*?<\/div>/,
  )?.[0];
  expect(score).toContain("<strong>未记录");
  expect(score).toContain("当时阈值 <b>未记录</b>");
  expect(score).not.toContain("<strong>0");
  expect(html).toContain("会话未记录");
});

it.each([
  {},
  { outcome: "attend", reasonCodes: ["future-rule"] },
  { outcome: "ignore", reasonCodes: ["muted", "wait-budget-exhausted"] },
])(
  "does not infer a path or score participation from incomplete or unknown history %j",
  (values) => {
    record({ ...values, score: 100, threshold: 80 });
    const html = render();
    expect(html).toContain("判定依据未确认");
    expect(html).toContain("历史记录未提供可确定的判断路径");
    expect(html).not.toContain('aria-label="本次判断路径"');
    expect(html).not.toContain('aria-label="评分依据"');
    expect(html).not.toContain("未作为本次结果的决定依据");
    expect(html).toContain("无法确认是否参与本次判定");
    if (values.reasonCodes?.includes("future-rule"))
      expect(html).toContain("future-rule");
  },
);

it("shows a closed red context signal for an explicit block and keeps the snapshot trace available", () => {
  record(
    { outcome: "ignore", reasonCodes: ["muted"] },
    contextSection({ muted: true }),
  );
  const html = render();
  const context = html.match(
    /<details class="gate-context">[\s\S]*?<\/details>/,
  )?.[0];
  const summary = context?.match(/<summary>[\s\S]*?<\/summary>/)?.[0];
  expect(html).toContain("查看来源");
  expect(summary).toContain("当时条件");
  expect(summary).toContain("gate-signal-danger");
  expect(summary).toContain("门禁拦截");
  expect(context).toContain("安全检查未记录");
  expect(context).toContain("取自当时的冻结快照");
  expect(html).not.toContain("关联上下文不可用");
});

it("shows a closed green signal for four passing checks and keeps scope and snapshot time in technical details", () => {
  record(
    { outcome: "attend", reasonCodes: ["score-threshold-met"] },
    contextSection({
      muted: false,
      safe: true,
      destinationAvailable: true,
      frequency: 0.5,
      focusActive: false,
      scopeKey: "scope-technical-only",
      asOf: "2026-09-19T07:40:00Z",
    }),
  );
  const html = render();
  const context = html.match(
    /<details class="gate-context">[\s\S]*?<\/details>/,
  )?.[0];
  const summary = context?.match(/<summary>[\s\S]*?<\/summary>/)?.[0];
  expect(summary).toContain("gate-signal-success");
  expect(summary).toContain("门禁通过");
  expect(summary).toContain("频率 0.5");
  expect(summary).toContain("未关注");
  expect(context).toContain("安全检查通过");
  expect(context).not.toContain("scope-technical-only");
  expect(context).not.toContain("2026-09-19T07:40:00Z");
  const technical = html.match(
    /<details class="gate-technical">[\s\S]*?<\/details>/,
  )?.[0];
  expect(technical).toContain("scope-technical-only");
  expect(technical).toContain("2026-09-19T07:40:00Z");
});

it("shows a closed warning signal for an incomplete snapshot even when focus is active", () => {
  record(
    { outcome: "attend", reasonCodes: ["private-conversation"] },
    contextSection({
      muted: false,
      safe: null,
      destinationAvailable: true,
      frequency: 0.5,
      focusActive: true,
    }),
  );
  const html = render();
  const context = html.match(
    /<details class="gate-context">[\s\S]*?<\/details>/,
  )?.[0];
  const summary = context?.match(/<summary>[\s\S]*?<\/summary>/)?.[0];
  expect(summary).toContain("gate-signal-warning");
  expect(summary).toContain("信息不全");
  expect(summary).toContain("关注中");
  expect(summary).not.toContain("门禁通过");
  expect(context).toContain("安全检查未记录");
});

it("distinguishes an empty directory from loading or a failed evaluation", () => {
  fixture.page = {
    data: inspectionRecordPageSchema.parse({
      version: 1,
      surfaceId: "gates",
      items: [],
      nextCursor: null,
    }),
  };
  const html = render();
  expect(html).toContain("尚无注意力评估记录");
  expect(html).toContain("未观察到记录不等于评估失败");
  expect(html).toContain("刷新记录");
  expect(html).not.toContain("正在读取判断依据");
  expect(html).not.toContain("当时分数达到阈值");
});

it("distinguishes directory loading and failure and offers a retry without showing stale evidence", () => {
  fixture.page = {};
  expect(render()).toContain("正在加载评估记录");
  fixture.page = { error: "HTTP 503" };
  const html = render();
  expect(html).toContain("评估记录读取失败：HTTP 503");
  expect(html).toContain("重新读取");
  expect(html).not.toContain("请看看这个实验方案");
  expect(html).not.toContain("当时分数达到阈值");
});

it("keeps the directory available while detail loading or failure hides its old explanation", () => {
  fixture.detail = {};
  expect(render()).toContain("正在读取判断依据");
  fixture.detail = { error: "详情不可用" };
  const html = render();
  expect(html).toContain("请看看这个实验方案");
  expect(html).toContain("评估详情读取失败：详情不可用");
  expect(html).toContain("重新读取");
  expect(html).not.toContain("当时分数达到阈值");
  expect(html).not.toContain('aria-label="评分依据"');
});
