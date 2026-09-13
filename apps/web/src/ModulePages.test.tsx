/**
 * 功能概述：验证模块详情深链接、原生链接交互和不同 Inspection 状态的用户可见结果。
 * 主要职责：往返编码测试覆盖直接地址与异常编码；点击测试保护修饰键行为；
 * HTML 检查确保总览保持紧凑、详情完整显示 Kind 说明并为编辑区域传入必要上下文。
 * 代码库关系：在真实 AppShell 导航上下文中渲染 ModulePage/ModuleDetails，不模拟展示字段转换。
 * 输入输出与副作用：只生成 HTML 和调用导航 spy，无网络、存储、真实配置应用或平台投递。
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { InspectionModule } from "@kaguya/schema";
import { AppShell } from "./components/AppShell.js";
import { developerPage } from "./DeveloperConsole.js";
import {
  type ModuleEditorProps,
  ModulePage,
  ModuleDetails,
  moduleDefinitionId,
  moduleDetailPath,
  navigateModuleLink,
} from "./ModulePages.js";

const module: InspectionModule = {
  definitionId: "agent.message-composer",
  displayName: "消息合成",
  summary: "根据冻结上下文生成消息。",
  description: "读取选定的上下文，通过模型生成正文并提出投递请求。",
  moduleVersion: "1.0.0",
  protocolVersion: 1,
  settingsSchemaFingerprint: "fingerprint",
  consumes: [
    {
      kind: "agent.message.intent.requested",
      displayName: "消息生成意图",
      description: "回合规划决定发言后产生，供消息合成使用。",
    },
  ],
  produces: [
    {
      kind: "core.message.assistant.text",
      displayName: "助手正文",
      description: "模型任务完成后产生，供后续平台投递使用。",
    },
  ],
  selectors: ["context.selector"],
  promptRenderers: [
    {
      rendererId: "prompt.renderer",
      displayName: "上下文渲染",
      description: "将选定输入转换为提示词。",
      kinds: ["agent.message.intent.requested"],
    },
  ],
  requires: [],
  provides: [],
  bindings: [],
  diagnostics: [],
};
function render(children: ReactNode) {
  return renderToStaticMarkup(
    <AppShell
      currentPath="/developer/modules"
      onNavigate={async () => true}
      registerNavigationGuard={() => () => {}}
    >
      {children}
    </AppShell>,
  );
}
describe("模块独立页面", () => {
  it("recognizes direct and refreshed detail paths with reversible ID encoding", () => {
    for (const id of [module.definitionId, "模块 /%?值"]) {
      const path = moduleDetailPath(id);
      expect(developerPage(path)).toBe("modules");
      expect(moduleDefinitionId(path)).toBe(id);
      expect(moduleDefinitionId(`${path}/`)).toBe(id);
    }
    expect(moduleDefinitionId("/developer/modules")).toBeUndefined();
    expect(moduleDefinitionId("/developer/modules/%ZZ")).toBe("%ZZ");
    expect(developerPage("/developer/modules/foo/bar")).toBeUndefined();
  });
  it("routes ordinary and keyboard-generated link clicks through the workbench", () => {
    const navigate = vi.fn(),
      preventDefault = vi.fn();
    navigateModuleLink(
      {
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault,
      },
      moduleDetailPath(module.definitionId),
      navigate,
    );
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      moduleDetailPath(module.definitionId),
    );
  });
  it.each([
    { metaKey: true },
    { ctrlKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
    { defaultPrevented: true },
  ])("preserves native modified link behavior %j", (override) => {
    const navigate = vi.fn(),
      preventDefault = vi.fn();
    navigateModuleLink(
      {
        button: 0,
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        defaultPrevented: false,
        preventDefault,
        ...override,
      },
      "/developer/modules",
      navigate,
    );
    expect(navigate).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
  it("keeps overview compact and provides a native accessible detail link", () => {
    const html = render(
      <ModulePage
        token="secret-token"
        path="/developer/modules"
        state={{ data: { modules: [module] } }}
      />,
    );
    expect(html).toContain(`href="${moduleDetailPath(module.definitionId)}"`);
    expect(html).toContain("输入 1 · 输出 1");
    expect(html).toContain("未激活");
    expect(html).toContain(module.summary);
    expect(html).not.toContain(module.description);
    expect(html).not.toContain(module.consumes[0]!.description);
    expect(html).not.toContain("secret-token");
  });
  it("shows semantic details and collapses renderer and technical metadata", () => {
    const html = render(
      <ModulePage
        token="test"
        path={moduleDetailPath(module.definitionId)}
        state={{ data: { modules: [module] } }}
      />,
    );
    expect(html).toContain(module.description);
    expect(html).toContain(module.consumes[0]!.description);
    expect(html).toContain(module.produces[0]!.description);
    expect(html.match(/<details/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain("返回模块总览");
    expect(html).toContain('tabindex="-1"');
  });
  it.each([
    [{}, "正在加载模块"],
    [{ error: "Runtime 尚未就绪" }, "模块检查暂不可用"],
    [{ data: { modules: [] } }, "当前运行时没有可用的模块定义"],
    [{ data: { modules: [module] } }, "未找到该模块"],
  ])("provides a return path for detail state %j", (state, message) => {
    const html = render(
      <ModulePage
        path="/developer/modules/missing"
        token="test"
        state={state}
      />,
    );
    expect(html).toContain(message);
    expect(html).toContain("返回模块总览");
  });
  it("passes only module identity and token to optional editor sections", () => {
    const settings = vi.fn<(props: ModuleEditorProps) => ReactNode>(() => (
        <p>配置表单</p>
      )),
      templates = vi.fn<(props: ModuleEditorProps) => ReactNode>(() => (
        <p>模板表单</p>
      ));
    const html = render(
      <ModuleDetails
        module={module}
        token="private-token"
        SettingsSection={settings}
        TemplatesSection={templates}
      />,
    );
    expect(settings.mock.calls[0]?.[0]).toEqual({
      definitionId: module.definitionId,
      token: "private-token",
    });
    expect(templates.mock.calls[0]?.[0]).toEqual({
      definitionId: module.definitionId,
      token: "private-token",
    });
    expect(html).toContain("配置表单");
    expect(html).toContain("模板表单");
    expect(html).not.toContain("private-token");
  });
});
