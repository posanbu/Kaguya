/**
 * 功能概述：验证逐请求检查的稳定路由、Manifest 分派、互斥详情与真实 DTO 展示边界。
 * 主要职责：使用 schema 校验的最小 API 样例模拟 useInspection，检查原生链接、请求 ID 编码、
 * 完整 Prompt、缺失上下文、非成功状态和空游标页；避免用模拟记录冒充实际模型结果。
 * 代码库关系：覆盖 ModulePage/ModuleSurface 到 RequestSurface 的生产调用链，浏览器另检查导航和响应式。
 * 输入输出与副作用：同步 SSR，无网络、数据库、Token 持久化或剪贴板写入；样例仅供测试与 UI 验证。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  inspectionRequestPageSchema,
  inspectionRequestDetailSchema,
  type InspectionModule,
  type InspectionRequestDetail,
} from "@kaguya/schema";
import { AppShell } from "./components/AppShell.js";
import { ModulePage, moduleDefinitionId } from "./ModulePages.js";
import { ModuleSurface } from "./ModuleSurface.js";
import { developerPage } from "./DeveloperConsole.js";
import { requestDetailPath, requestRoute } from "./request-routes.js";

const fixture = vi.hoisted(() => ({
  page: {} as Record<string, unknown>,
  detail: {} as Record<string, unknown>,
  paths: [] as string[],
}));
vi.mock("./use-inspection.js", () => ({
  useInspection: (_token: string, path?: string) => {
    if (path) fixture.paths.push(path);
    return !path
      ? {}
      : path.includes("/requests/")
        ? fixture.detail
        : fixture.page;
  },
}));
const definitionId = "custom.request/module";
const requestId = "request /%?中文";
const base = `/developer/modules/${encodeURIComponent(definitionId)}`;
const fullPrompt = `${"完整请求上下文\n".repeat(500)}PROMPT_FINAL_SENTINEL`;
const browser = {
  id: "requests",
  type: "model-request-browser",
  area: "main",
  viewId: "requests",
  taskId: "custom.task",
  mode: "planner",
} as const;
const module = {
  definitionId,
  displayName: "自定义请求模块",
  summary: "按请求查看决定。",
  description: "不应出现在请求详情中的技术说明",
  moduleVersion: "1",
  protocolVersion: 1,
  settingsSchemaFingerprint: "test",
  consumes: [],
  produces: [],
  selectors: [],
  promptRenderers: [],
  requires: [],
  provides: [],
  bindings: [],
  diagnostics: [],
  inspection: {
    mechanism: [],
    views: [],
    surface: {
      version: 1,
      id: "request-surface",
      title: "自定义请求历史",
      layout: { type: "master-detail", areas: ["main"] },
      components: [browser],
    },
  },
} as InspectionModule;
function detailData() {
  return fixture.detail.data as InspectionRequestDetail;
}
function render(path = base, currentModule = module, surfaceOnly = false) {
  return renderToStaticMarkup(
    <AppShell
      currentPath={path}
      onNavigate={async () => true}
      registerNavigationGuard={() => () => {}}
    >
      {surfaceOnly ? (
        <ModuleSurface
          module={currentModule}
          token="never-render-token"
          path={path}
          revision={0}
          DetailComponent={({ selected }) => <p>通用 Atom 详情 {selected}</p>}
        />
      ) : (
        <ModulePage
          state={{ data: { modules: [currentModule] } }}
          path={path}
          token="never-render-token"
          DetailComponent={({ selected }) => <p>通用 Atom 详情 {selected}</p>}
          SettingsSection={() => <p>配置编辑入口</p>}
          TemplatesSection={() => <p>模板编辑入口</p>}
        />
      )}
    </AppShell>,
  );
}
beforeEach(() => {
  fixture.paths = [];
  const summary = {
    requestId,
    occurredAt: "2026-09-19T10:20:00Z",
    status: "completed",
    triggerText: "请确认下一步",
    outcomeText: "回复消息",
    inputCount: 2,
  };
  fixture.page = {
    data: inspectionRequestPageSchema.parse({
      version: 1,
      surfaceId: "request-surface",
      items: [summary],
      nextCursor: null,
    }),
  };
  fixture.detail = {
    data: inspectionRequestDetailSchema.parse({
      version: 1,
      surfaceId: "request-surface",
      request: summary,
      inputs: [
        {
          informationId: "input-1",
          sender: "测试用户",
          text: "触发输入全文",
          occurredAt: summary.occurredAt,
        },
      ],
      prompt: { available: true, text: fullPrompt },
      result: { action: "message", reason: "respond", text: "生成结果正文" },
      model: [{ label: "模型", value: "test-model" }],
      trace: [
        {
          informationId: "delivery-1",
          kind: "core.delivery.completed",
          occurredAt: summary.occurredAt,
          label: "实际投递回执",
          status: "failed",
        },
      ],
      truncated: false,
      contextAvailable: true,
    }),
  };
});

describe("逐请求页面", () => {
  it("round trips encoded identities and accepts only the three supported detail routes", () => {
    for (const view of ["overview", "prompt", "sources"] as const) {
      const path = requestDetailPath(definitionId, requestId, view);
      expect(requestRoute(path)).toEqual({ definitionId, requestId, view });
      expect(requestRoute(`${path}/`)).toEqual({
        definitionId,
        requestId,
        view,
      });
      expect(moduleDefinitionId(path)).toBe(definitionId);
      expect(developerPage(path)).toBe("modules");
    }
    for (const suffix of ["/unknown", "/prompt/extra", "/requests"]) {
      expect(
        requestRoute(`${requestDetailPath(definitionId, requestId)}${suffix}`),
      ).toBeUndefined();
    }
    expect(requestRoute(`${base}/requests/%ZZ`)).toBeUndefined();
    const sourcePath = requestDetailPath(
      definitionId,
      requestId,
      "sources",
      "原文 /%?",
    );
    expect(requestRoute(sourcePath)).toEqual({
      definitionId,
      requestId,
      view: "sources",
      sourceInformationId: "原文 /%?",
    });
    expect(developerPage(sourcePath)).toBe("modules");
  });
  it("dispatches from metadata and renders a native whole-row detail link without a split pane", () => {
    const html = render(base, module, true);
    expect(html).toContain("自定义请求历史");
    expect(html).toContain(
      `href="${requestDetailPath(definitionId, requestId)}"`,
    );
    expect(html).toContain("请确认下一步");
    expect(html).toContain("回复消息");
    expect(html).toContain("本页 1 次请求 · 非全部统计");
    expect(html).not.toContain("通用 Atom 详情");
    expect(html).not.toContain("never-render-token");
    expect(fixture.paths).toEqual([
      "modules/custom.request%2Fmodule/surfaces/request-surface?limit=20",
    ]);
  });
  it("replaces the module and list with an overview while leaving prompt and sources on other pages", () => {
    const html = render(requestDetailPath(definitionId, requestId));
    expect(html).toContain("触发输入全文");
    expect(html).toContain("回应消息");
    expect(html).toContain("返回Planner 决策列表");
    expect(html).not.toContain(fullPrompt);
    expect(html).not.toContain("实际投递回执");
    expect(html).not.toContain("不应出现在请求详情中的技术说明");
    expect(html).not.toContain("模块职责与输入输出");
    expect(html).not.toContain("request-summary");
    expect(html).not.toContain("<details");
    expect(html).not.toContain("配置编辑入口");
    expect(html).not.toContain("模板编辑入口");
    expect(fixture.paths).toEqual([
      "modules/custom.request%2Fmodule/surfaces/request-surface/requests/request%20%2F%25%3F%E4%B8%AD%E6%96%87",
    ]);
  });
  it("keeps existing settings and template capabilities on the module list page", () => {
    const html = render();
    expect(html).toContain("配置编辑入口");
    expect(html).toContain("模板编辑入口");
    expect(html).toContain("模块职责与输入输出");
  });
  it("shows the entire stored prompt only on its own page", () => {
    const html = render(requestDetailPath(definitionId, requestId, "prompt"));
    expect(html).toContain(fullPrompt);
    expect(html).toContain("复制完整 Prompt");
    expect(html).not.toContain("触发输入全文");
    expect(html).not.toContain("实际投递回执");
    expect(html).not.toContain("<details");
    expect(html).toContain('aria-current="page">完整 Prompt');
  });
  it("shows only real trace receipts without equating a failed delivery with model completion", () => {
    const html = render(requestDetailPath(definitionId, requestId, "sources"));
    expect(html).toContain("实际投递回执");
    expect(html).toContain("失败");
    expect(html).toContain("delivery-1");
    expect(html).toContain(
      `href="${requestDetailPath(definitionId, requestId, "sources", "delivery-1")}"`,
    );
    expect(html).toContain("test-model");
    expect(html).not.toContain(fullPrompt);
    expect(html).not.toContain("触发输入全文");
    expect(html).not.toContain("生成结果正文");
  });
  it("replaces source history with one referenced atom and rejects unrelated identities", () => {
    const html = render(
      requestDetailPath(definitionId, requestId, "sources", "delivery-1"),
    );
    expect(html).toContain("通用 Atom 详情 delivery-1");
    expect(html).toContain("返回来源与投递");
    expect(html).not.toContain("request-trace");
    expect(html).not.toContain("实际投递回执");
    const invalid = render(
      requestDetailPath(definitionId, requestId, "sources", "unrelated"),
    );
    expect(invalid).toContain("不在本次请求的可用关联集合");
    expect(invalid).not.toContain("通用 Atom 详情");
  });
  it("uses composer metadata to show generated content instead of planner actions", () => {
    const composer = structuredClone(module);
    Object.assign(composer.inspection!.surface!.components[0]!, {
      mode: "composer",
    });
    const html = render(requestDetailPath(definitionId, requestId), composer);
    expect(html).toContain("消息生成详情");
    expect(html).toContain("生成结果正文");
    detailData().request.triggerKind = "authorization";
    expect(
      render(requestDetailPath(definitionId, requestId), composer),
    ).toContain("授权发送要求");
  });
  it("does not fabricate unavailable context or prompt", () => {
    Object.assign(detailData(), {
      inputs: [],
      contextAvailable: false,
      prompt: { available: false },
    });
    expect(render(requestDetailPath(definitionId, requestId))).toContain(
      "触发上下文不可用",
    );
    const html = render(requestDetailPath(definitionId, requestId, "prompt"));
    expect(html).toContain("未保存可读取的 Prompt");
    expect(html).not.toContain("复制完整 Prompt");
  });
  it.each(["pending", "failed", "cancelled", "interrupted"])(
    "retains non-success request status %s",
    (status) => {
      Object.assign(detailData().request, { status, outcomeText: "" });
      detailData().result = {};
      const html = render(requestDetailPath(definitionId, requestId));
      expect(html).not.toContain("已完成");
      expect(html).not.toContain("回复消息");
      expect(html).toContain(
        (
          {
            pending: "未记录结果",
            failed: "失败",
            cancelled: "已取消",
            interrupted: "已中断",
          } as Record<string, string>
        )[status],
      );
    },
  );
  it("keeps empty pages pageable and separates loading from failed reads", () => {
    fixture.page = {
      data: inspectionRequestPageSchema.parse({
        version: 1,
        surfaceId: "request-surface",
        items: [],
        nextCursor: "next-valid-page",
      }),
    };
    let html = render();
    expect(html).toContain("暂无请求记录");
    expect(html).toMatch(/<button[^>]*>下一页<\/button>/);
    fixture.page = {};
    expect(render()).toContain("正在加载请求记录");
    fixture.detail = { error: "request_not_found" };
    html = render(requestDetailPath(definitionId, "unknown"));
    expect(html).toContain("这次请求不可用");
    expect(html).toContain("重新读取");
    expect(html).not.toContain(fullPrompt);
  });
});
