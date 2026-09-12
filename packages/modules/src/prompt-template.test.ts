/**
 * 功能概述：验证受限 Handlebars 编译器的模板语法、变量使用和 provenance。
 * 主要职责：通过 compilePromptTemplateSet 与 createPromptTemplateRenderer 检查重复变量、静态 partial 及非法语法。
 * 输入输出与副作用：在内存中编译 message Prompt，不访问模型或账本；未知变量和越界模板应抛错。
 */
import { describe, expect, it } from "vitest";

import {
  compilePromptTemplateSet,
  createPromptTemplateRenderer,
} from "./prompt-template.js";

const variables = [
  { name: "history", content: "<history>raw</history>", informationIds: ["a"] },
  { name: "target", content: "hello", informationIds: ["b"] },
];

describe("restricted Handlebars Prompt templates", () => {
  it("allows zero and repeated references, renders raw content, and tracks used variables once", () => {
    const render = createPromptTemplateRenderer({
      kind: "message",
      templateId: "test.reply",
      main: {
        name: "main",
        content: "{{target}}/{{target}}",
        allowedVariables: ["history", "target"],
      },
    });

    const prompt = render(variables);
    expect(prompt.text).toBe("hello/hello");
    expect(prompt.variables).toEqual([variables[1]]);
    expect(prompt.templates).toEqual([
      { name: "main", content: "{{target}}/{{target}}" },
    ]);
  });

  it("supports ordered each/if nesting and static partials", () => {
    const compiled = compilePromptTemplateSet([
      {
        name: "list",
        content:
          "{{#each items}}{{#if inbound}}{{> item}}{{else}}A:{{content}}{{/if}}{{/each}}",
        allowedVariables: ["items", "inbound", "content"],
        allowedPartials: ["item"],
      },
      {
        name: "item",
        content: "U:{{content}}",
        allowedVariables: ["content"],
      },
    ]);
    expect(
      compiled.render("list", {
        items: [
          { inbound: true, content: "one" },
          { inbound: false, content: "two" },
        ],
      }),
    ).toBe("U:oneA:two");
  });

  it("does not escape dynamic content", () => {
    const render = createPromptTemplateRenderer({
      kind: "message",
      templateId: "test.raw",
      main: {
        name: "main",
        content: "{{history}}",
        allowedVariables: ["history"],
      },
    });
    expect(render(variables.slice(0, 1)).text).toBe("<history>raw</history>");
  });

  it("reuses a compiled template set with the same source and contract", () => {
    const definitions = [
      { name: "static", content: "fixed", allowedVariables: [] },
    ] as const;
    expect(compilePromptTemplateSet(definitions)).toBe(
      compilePromptTemplateSet(definitions),
    );
  });

  it.each([
    ["unknown variable", "{{unknown}}", []],
    ["unknown partial", "{{> other}}", []],
    ["dynamic partial", '{{> (lookup . "which")}}', ["other"]],
    ["custom helper", "{{#with target}}{{this}}{{/with}}", []],
    ["subexpression", "{{target (if history)}}", []],
  ])("rejects %s", (_case, content, allowedPartials) => {
    expect(() =>
      compilePromptTemplateSet([
        {
          name: "main",
          content,
          allowedVariables: ["target", "history"],
          allowedPartials,
        },
      ]),
    ).toThrow();
  });

  it("rejects recursive partials and empty templates", () => {
    expect(() =>
      compilePromptTemplateSet([
        {
          name: "one",
          content: "{{> two}}",
          allowedVariables: [],
          allowedPartials: ["two"],
        },
        {
          name: "two",
          content: "{{> one}}",
          allowedVariables: [],
          allowedPartials: ["one"],
        },
      ]),
    ).toThrow("Recursive");
    expect(() =>
      compilePromptTemplateSet([
        { name: "main", content: "", allowedVariables: [] },
      ]),
    ).toThrow("empty");
  });
});
