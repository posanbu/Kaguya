/**
 * 功能概述：验证领域 UI 对目录错误、配对证据和 Memory 可用性的展示边界。
 * 静态 React 渲染使用合成 DTO，正式 schema 校验数据；覆盖目录409但详情200及迟到请求链。
 * useInspection 仅替代网络读取，不声称验证物理执行；无异步后台资源，浏览器竞态另行验收。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  inspectionRunDetailSchema,
  inspectionActionDetailSchema,
  inspectionMemoryHistorySchema,
} from "@kaguya/schema";
import { AppShell } from "./components/AppShell.js";
import { DomainInspection, DomainFields } from "./DomainInspection.js";
const responses = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path: string | undefined) =>
    responses.get(path ?? "") ?? {},
}));
afterEach(() => responses.clear());
const meta = {
  version: 1,
  scope: "scope",
  boundary: { position: "10", recordedAt: "2026-01-01T00:00:00Z" },
  stateReadAt: "2026-01-02T00:00:00Z",
};
const safe = (value: string) => ({ value, omitted: [], truncated: false });
const html = (location: string) =>
  renderToStaticMarkup(
    <AppShell
      currentPath="/situation"
      onNavigate={async () => true}
      registerNavigationGuard={() => () => {}}
    >
      <DomainInspection token="synthetic" location={location} />
    </AppShell>,
  );
it("keeps stable IDs verbatim even when they match status words", () => {
  const result = renderToStaticMarkup(
    <DomainFields
      value={{
        runInformationId: "native-run",
        environmentId: "human",
        status: "unknown",
      }}
    />,
  );
  expect(result).toContain("native-run");
  expect(result).toContain("human");
  expect(result).toContain("结果未知");
  expect(result).not.toContain("模型运行投影");
});
it("shows independently readable detail when the directory cursor returns 409, hiding invalid paired body", () => {
  responses.set("runs?scope=scope&limit=20&cursor=stale", {
    error: "directory changed",
    code: "inspection_directory_changed",
    status: 409,
  });
  responses.set("runs/run?scope=scope", {
    data: inspectionRunDetailSchema.parse({
      ...meta,
      run: {
        runInformationId: "run",
        actionRunInformationId: "action-run",
        observationId: "obs",
        sceneId: "scene",
        at: "now",
        deadline: "then",
        terminalReason: "model-outcome-unknown",
      },
      budget: safe("budget"),
      usage: { admittedSteps: 1, registeredCalls: 1, projectedOutputBytes: 10 },
      cancellation: {
        state: "forwarded",
        requestedInformationId: "cancel-request",
        forwardedInformationId: "cancel-forwarded",
      },
      steps: [],
      stepsTruncated: true,
      calls: [
        {
          stepIndex: 0,
          callIndex: 0,
          toolCallId: "call",
          toolId: null,
          toolVersion: null,
          wireName: "tool",
          validation: "valid",
          arguments: safe("arguments"),
          modelCompletedInformationId: "model",
          intent: null,
          resultInformationId: "result",
          receipt: null,
          result: safe("UNTRUSTED BODY"),
          outputBytes: null,
          pairing: "invalid",
        },
      ],
      callsTruncated: false,
      references: [],
    }),
  });
  const result = html(
    "/situation?inspect=run&scope=scope&selected=run&cursor=stale",
  );
  expect(result).toContain("刷新首屏");
  expect(result).toContain("模型结果未知");
  expect(result).toContain("配对校验未通过");
  expect(result).not.toContain("UNTRUSTED BODY");
  expect(result).toContain("cancel-request");
  expect(result).toContain("cancel-forwarded");
  expect(result).toContain("已准入步骤数");
  expect(result).not.toContain("成功步数");
});
it("retains late source/request identity chains and their independent omissions", () => {
  responses.set("actions?scope=scope&limit=20", {
    data: { ...meta, items: [], nextCursor: null, truncated: false },
  });
  responses.set("actions/intent?scope=scope", {
    data: inspectionActionDetailSchema.parse({
      ...meta,
      action: {
        intentId: "intent",
        at: "now",
        state: "unknown",
        runInformationId: "run",
        decisionInformationId: "decision",
        observationId: "obs",
        toolName: "tool",
        attemptId: null,
        receiptId: null,
        cancellationId: null,
      },
      intent: safe("intent"),
      receipts: [],
      receiptsTruncated: false,
      lateEvidence: [
        {
          informationId: "late",
          at: "now",
          responseDigest: "digest",
          source: {
            value: "connection-revision-proof",
            omitted: ["private-path"],
            truncated: true,
          },
          requests: safe("operation-attempt-chain"),
          value: safe("late-value"),
        },
      ],
      lateEvidenceTruncated: true,
      rejectedEvidenceCount: 2,
      references: [
        {
          domain: "atom",
          id: "denied-id",
          relation: "source",
          availability: "missing-or-denied",
        },
      ],
    }),
  });
  const result = html("/situation?inspect=action&scope=scope&selected=intent");
  expect(result).toContain("connection-revision-proof");
  expect(result).toContain("operation-attempt-chain");
  expect(result).toContain("private-path");
  expect(result).toContain("来源缺失或不可访问");
  expect(result).not.toContain("selected=denied-id");
  expect(result).toContain("结果未知");
});
it("preserves frozen publication identity while withholding unavailable Memory content", () => {
  responses.set("memory/node/history?scope=scope&observationId=obs&limit=20", {
    data: inspectionMemoryHistorySchema.parse({
      ...meta,
      directory: { limit: 500, truncated: true },
      items: [
        {
          nodeId: "node",
          revision: 2,
          publicationInformationId: "original-publication",
          publicationPosition: "8",
          status: "active",
          availability: "unavailable",
          reasons: ["source-withdrawal"],
          historical: safe("WITHDRAWN BODY"),
          references: [],
          referencesTruncated: false,
        },
      ],
      nextCursor: null,
      truncated: false,
      observationId: "obs",
      stepInformationId: null,
      knowledgeCutoff: "9",
      excludedCount: 0,
      exclusionReason: null,
    }),
  });
  const result = html(
    "/memory?inspect=memory&scope=scope&selected=node&observation=obs",
  );
  expect(result).toContain("original-publication");
  expect(result).toContain("当时知识截止位置");
  expect(result).toContain("来源已撤回");
  expect(result).not.toContain("WITHDRAWN BODY");
  expect(result).toContain("窗口外仍有历史");
});
