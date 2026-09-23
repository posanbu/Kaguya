/**
 * 功能概述：验证壳层导航及基础控件的无障碍输出契约，防止路由迁移丢失当前位置。
 * 主要职责：覆盖深层检查/配置路由，五域入口、默认按钮类型、错误反馈和标题语义。
 * 代码库关系：直接渲染 SideNav 与 ui.tsx；浏览器焦点和抽屉交互另行真实浏览器验收。
 * 输入输出与副作用：React 服务端渲染生成静态 HTML，无网络、Token 或配置写入。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SideNav, navigationDomain } from "./AppShell.js";
import { Button, FieldMessage, PageHeader } from "./ui.js";
describe("工作台导航契约", () => {
  it("深层页面归属于稳定的任务域", () => {
    expect(navigationDomain("/developer/flows")).toBe("/developer/modules");
    expect(navigationDomain("/configuration/application")).toBe("/profiles");
    expect(navigationDomain("/adapters")).toBe("/");
    expect(navigationDomain("/messages")).toBe("/messages");
    expect(navigationDomain("/memory")).toBe("/memory");
    expect(navigationDomain("/")).toBe("/");
  });
  it("五个键盘可达链接只标记一个当前域", () => {
    const html = renderToStaticMarkup(
      <SideNav currentPath="/developer/atoms" onNavigate={() => {}} />,
    );
    expect(html.match(/<a /g)).toHaveLength(5);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('href="/developer/modules" aria-current="page"');
    for (const label of ["概览", "消息", "记忆录入", "配置", "检查"])
      expect(html).toContain(label);
    expect(html).not.toContain('href="/adapters"');
  });
  it("按钮不隐式提交，页面标题和字段错误有可访问语义", () => {
    expect(renderToStaticMarkup(<Button>取消</Button>)).toContain(
      'type="button"',
    );
    expect(renderToStaticMarkup(<Button type="submit">保存</Button>)).toContain(
      'type="submit"',
    );
    const pageHeader = renderToStaticMarkup(<PageHeader title="配置" />);
    expect(pageHeader).toContain("<h1>配置</h1>");
    expect(pageHeader).not.toContain("页面说明");
    expect(
      renderToStaticMarkup(
        <FieldMessage id="name-error" tone="error">
          名称重复
        </FieldMessage>,
      ),
    ).toContain('role="alert"');
  });
});
