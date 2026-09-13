/**
 * 功能概述：保护检查页迁入工作台后的表单和二级导航语义。
 * 主要职责：确认 Atom/Flow 筛选仍显式提交表单，公共 Button 默认类型不会吞掉查询；
 * 验证三个检查页保留当前页链接，页面不再渲染私有顶栏。
 * 代码库关系：服务端渲染 DeveloperConsole；数据查询、取消和分页由已有 inspection 测试覆盖。
 * 输入输出与副作用：不挂载 effect、不访问网络，只检查用户实际获得的 HTML 语义。
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeveloperConsole } from "./DeveloperConsole.js";
describe("检查页工作台迁移", () => {
  for (const page of ["modules", "atoms", "flows"] as const) {
    it(`${page} 保留二级导航与共同标题`, () => {
      const html = renderToStaticMarkup(
        createElement(DeveloperConsole, {
          token: "test",
          page,
          navigate: () => {},
        }),
      );
      expect(html).toContain("<h1>检查</h1>");
      expect(html).not.toContain('class="topbar"');
      expect(html).not.toContain("返回消息");
      expect(html).toContain(`href="/developer/${page}" aria-current="page"`);
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
      if (page !== "modules")
        expect(html).toMatch(/<button[^>]*type="submit"[^>]*>筛选<\/button>/);
    });
  }
});
