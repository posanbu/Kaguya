/**
 * 功能概述：验证人类可读字段的结果、结构化习惯和不可信文本渲染。
 * 静态渲染使用真实组件，保证状态有中文、未知值保留且正文不能注入 HTML。
 * 不访问网络或存储；模块页面实际查询与分页由 Server 集成测试和浏览器验收覆盖。
 */
import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InspectionFields, InspectionStatus } from "./InspectionFields.js";
it("renders observation state and habits without exposing raw JSON as the primary view", () => {
  const html = renderToStaticMarkup(
    <>
      <InspectionStatus value="defer" />
      <InspectionFields
        fields={[
          { label: "结果", value: "observe" },
          { label: "未读数量", value: 3 },
          { label: "原因", value: ["periodic-recheck"] },
          {
            label: "表达习惯",
            value: [
              {
                situation: "解释问题",
                style: "逐步解释",
                occurrences: 3,
                reviewStatus: "validated",
              },
            ],
          },
        ]}
      />
    </>,
  );
  for (const text of [
    "延后观察",
    "查看未读",
    "periodic-recheck",
    "情境",
    "逐步解释",
    "出现次数",
    "已验证",
  ])
    expect(html).toContain(text);
  expect(html).not.toContain("<pre>");
});
it("escapes content and retains unfamiliar diagnostic codes", () => {
  const html = renderToStaticMarkup(
    <InspectionFields
      fields={[
        { label: "正文", value: "<img src=x onerror=alert(1)>" },
        { label: "原因", value: "future-reason" },
        { label: "正文", value: "wait" },
      ]}
    />,
  );
  expect(html).not.toContain("<img");
  expect(html).toContain("&lt;img");
  expect(html).toContain("future-reason");
  expect(html).toContain(">wait</span>");
});
