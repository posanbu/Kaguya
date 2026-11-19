import { loadFirstPartyPromptTemplates } from "../../node/prompt-templates.js";
import { continuityTemplateDeclaration } from "../../prompt-declarations.js";
import { createPromptTemplateRenderer } from "../../prompt-template.js";
import { expect, it } from "vitest";
import { nativeMemorySnapshotSchema } from "@kaguya/schema";
import { createFormationPromptRenderer } from "./formation-prompt.js";

it("renders the frozen request unchanged and preserves legacy prompt variables", () => {
  const input = {
    batchId: "batch",
    scope: "scope",
    sources: [],
    existing: nativeMemorySnapshotSchema.parse({
      version: 1,
      status: "enabled",
      frozenAt: "2026-11-01T00:00:00Z",
      scope: "scope",
      owners: [],
      fixed: [],
      recalled: [],
      degraded: [],
      budget: { dynamicCharacters: 0, omittedNodeIds: [] },
    }),
  };
  const render = createFormationPromptRenderer("{{context}}");
  const prompt = render(input, ["source"]);
  expect(prompt.templateId).toBe("memory.native.form.v1");
  expect(JSON.parse(prompt.text)).toEqual(input);
  expect(prompt.variables).toEqual([
    {
      name: "context",
      content: JSON.stringify(input),
      informationIds: ["source"],
    },
  ]);
  const next = render(
    { ...input, formationPolicy: "experience-operations.v1" },
    ["source"],
  );
  expect(JSON.parse(next.text)).toMatchObject({
    ...input,
    formationRules: { policy: "experience-operations.v1" },
  });
  expect(JSON.parse(next.text).formationRules.instructions).toContain(
    "不把旁观者内容归给被提问者",
  );
  expect(JSON.parse(prompt.text)).not.toHaveProperty("formationRules");
  expect(input).not.toHaveProperty("formationRules");
});

it("saves the rendered activity appraisal, consolidation and self-revision instructions with fixed evidence", () => {
  const templates = loadFirstPartyPromptTemplates();
  const evidence = {
    activityId: "reading",
    activityRevision: 2,
    activityInformationId: "activity-2",
    expectation: "核对笔记的章节",
    state: "waiting",
    result: "partial",
    fulfillment: "unknown",
    reportedSteps: ["读取第一页"],
    receiptIds: ["receipt-1"],
    artifactIds: [],
    feedbackIds: [],
    deliveryIds: [],
    appraisal: "尚需核对下一页",
    causeHypothesis: null,
  };
  const render = createPromptTemplateRenderer({
    kind: "state",
    templateId: "agent.continuity.v1",
    main: { ...continuityTemplateDeclaration, content: templates.continuity },
  });
  expect(
    render([
      { name: "phase", content: "执行", informationIds: [] },
      {
        name: "context",
        content: JSON.stringify(evidence),
        informationIds: ["activity-2"],
      },
    ]).text,
  ).toMatchSnapshot();
  const at = "2026-10-22T00:00:00.000Z",
    scope = '["web","test","web","reading"]';
  const node = {
    id: "00000000-0000-4000-8000-000000000001",
    content: "已读第一页，第二页未验证",
    metadata: {
      occurredAt: at,
      kind: "experience",
      system: "native-v1",
      ownerId: "self:kaguya",
      scope,
      level: 1,
      revision: 1,
      status: "active",
      locked: false,
      tags: [],
      aliases: [],
      sourceIds: ["source-1"],
      activityReflection: evidence,
    },
  };
  const existing = nativeMemorySnapshotSchema.parse({
    version: 1,
    scope,
    owners: ["self:kaguya"],
    status: "enabled",
    frozenAt: at,
    fixed: [],
    recalled: [{ node, traces: [], truncated: false }],
    degraded: [],
    budget: { dynamicCharacters: 0, omittedNodeIds: [] },
  });
  const prompt = createFormationPromptRenderer(templates.nativeMemory)(
    {
      batchId: "reading-correction",
      scope,
      existing,
      formationPolicy: "experience-operations.v1",
      activityReviewIntervalMs: 86400000,
      sources: [
        {
          id: "correction-1",
          scope,
          ownerId: "conversation:" + scope,
          text: "勘误：此处是第二章",
          sourceType: "inbound",
          occurredAt: at,
          collectedAt: at,
          participants: [],
          replyTo: null,
        },
      ],
    },
    ["correction-1"],
  );
  expect(prompt.text).toMatchSnapshot();
});
