/**
 * 功能概述：自动发现生产一方定义，约束面向维护者的中文自描述，避免新增模块遗漏中央清单。
 * 主要职责：scanMetadata 使用 TypeScript AST 检查 Kind 与模块 Manifest 的必需展示字段；
 * textViolations 拒绝空值、非中文、过短说明和通用占位文本，变异样例验证规则确实能阻止回归。
 * 代码库关系：递归扫描 packages/apps 的 src，排除 SDK 定义工具及明确测试文件；
 * Inspection 集成用例使用真实 Catalog 和 ModuleHost，证明名称及输入输出说明来自同一份定义。
 * 输入输出与副作用：仅本地读文件和内存组装，无数据库、模型、平台发送或配置应用；
 * 动态状态元数据必须以内联中文对象声明各分支，无法静态核验的表达式直接报告而非静默跳过。
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { createMessageCatalog } from "../packages/composition/src/index.js";
import { InformationCore, ModuleHost } from "../packages/engine/src/index.js";

function textViolations(field: string, value: string): string[] {
  const han = value.match(/\p{Script=Han}/gu) ?? [];
  const errors: string[] = [];
  if (han.length < (field === "displayName" ? 2 : 12))
    errors.push(`${field}: 需要中文名称或完整职责说明`);
  if (
    /Information carried by|\b(?:TODO|TBD|placeholder)\b|待补充|占位|测试模块|通用模块|(?:信息|数据)原子[。.]?$/iu.test(
      value,
    )
  )
    errors.push(`${field}: 不允许通用占位说明`);
  return errors;
}

function property(object: ts.ObjectLiteralExpression, name: string) {
  return object.properties.find(
    (item): item is ts.PropertyAssignment =>
      ts.isPropertyAssignment(item) &&
      item.name.getText().replaceAll(/["']/g, "") === name,
  )?.initializer;
}

// 只接受可审阅的字面文本或内联状态分支，禁止计算表达式掩盖未翻译的运行时名称。
function texts(node: ts.Expression): string[] | undefined {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node))
    return texts(node.expression);
  if (
    ts.isElementAccessExpression(node) &&
    ts.isObjectLiteralExpression(node.expression)
  ) {
    const values = node.expression.properties.map((item) =>
      ts.isPropertyAssignment(item) ? texts(item.initializer) : undefined,
    );
    return values.length && values.every((value) => value !== undefined)
      ? (values.flat() as string[])
      : undefined;
  }
  return undefined;
}

function scanMetadata(source: string): {
  definitions: number;
  errors: string[];
} {
  const file = ts.createSourceFile(
    "metadata.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const errors: string[] = [];
  let definitions = 0;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ["defineInformationKind", "defineInformationModule"].includes(
        node.expression.text,
      )
    ) {
      definitions++;
      const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const argument = node.arguments[0];
      const module = node.expression.text === "defineInformationModule";
      const object =
        argument && ts.isObjectLiteralExpression(argument)
          ? module
            ? property(argument, "manifest")
            : argument
          : undefined;
      if (!object || !ts.isObjectLiteralExpression(object)) {
        errors.push(`${line}: 定义需提供可核验的内联元数据`);
      } else {
        for (const field of module
          ? ["displayName", "summary", "description"]
          : ["displayName", "description"]) {
          const expression = property(object, field);
          const values = expression && texts(expression);
          if (!values) errors.push(`${line}: ${field}: 缺少可核验的中文文本`);
          else
            for (const value of values)
              errors.push(
                ...textViolations(field, value).map(
                  (error) => `${line}: ${error}`,
                ),
              );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return { definitions, errors };
}

async function sources(directory: URL): Promise<URL[]> {
  const found: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".worktrees", ".git"].includes(entry.name))
      continue;
    const path = new URL(
      entry.name + (entry.isDirectory() ? "/" : ""),
      directory,
    );
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/(?:\.test|\.contract|test-fixtures)\./.test(entry.name) &&
      path.pathname.includes("/src/") &&
      !path.pathname.includes("/packages/sdk/")
    )
      found.push(path);
  }
  return found;
}

describe("production Chinese self-description", () => {
  it("discovers module factories and shared Core, Runtime and Scheduler kinds without a definition allowlist", async () => {
    const files = [
      ...(await sources(new URL("../packages/", import.meta.url))),
      ...(await sources(new URL("../apps/", import.meta.url))),
    ];
    const errors: string[] = [];
    let definitions = 0;
    for (const file of files) {
      const result = scanMetadata(await readFile(file, "utf8"));
      definitions += result.definitions;
      errors.push(
        ...result.errors.map((error) => `${fileURLToPath(file)}:${error}`),
      );
    }
    expect(definitions).toBeGreaterThan(70);
    expect(errors).toEqual([]);
  });

  it.each([
    [
      'displayName: "English name", description: "输入消息到达后形成请求，供下游处理并记录结果。"',
      "需要中文",
    ],
    ['displayName: "入站消息"', "缺少可核验"],
    [
      'displayName: "入站消息", description: "Information carried by the core.message kind. 中文说明"',
      "占位",
    ],
    [
      'displayName: "入站消息", description: "待补充详细的中文业务职责和下游使用说明"',
      "占位",
    ],
    ['displayName: "入站消息", description: "入站消息"', "完整职责"],
    [
      'displayName: runtimeName, description: "输入消息到达后形成请求，供下游处理并记录结果。"',
      "缺少可核验",
    ],
  ])("rejects invalid new Kind metadata: %s", (fields, error) => {
    expect(
      scanMetadata(
        `defineInformationKind({kind: "new.kind", ${fields}})`,
      ).errors.join("\n"),
    ).toContain(error);
  });

  it("requires every module field and every dynamic terminal branch", () => {
    expect(
      scanMetadata(
        'defineInformationModule({manifest: {displayName: "新增模块", description: "输入消息到达后形成请求，供下游处理并记录结果。"}})',
      ).errors.join(),
    ).toContain("summary");
    expect(
      scanMetadata(
        'defineInformationKind({displayName: {completed: "写回完成", failed: "Failed"}[status], description: "输入消息到达后形成请求，供下游处理并记录结果。"})',
      ).errors.join(),
    ).toContain("需要中文");
  });

  it("accepts semantic Chinese descriptions with stable English technical identifiers", () => {
    expect(
      scanMetadata(
        'defineInformationModule({manifest: {displayName: "消息合成", summary: "根据冻结的上下文生成待投递消息正文。", description: "消费消息意图，通过 Model Task 生成正文，输出投递请求供 Runtime 发送。"}})',
      ).errors,
    ).toEqual([]);
  });

  it("exposes actual catalog metadata unchanged through module inspection", () => {
    const catalog = createMessageCatalog();
    const host = new ModuleHost({ core: {} as InformationCore, catalog });
    const inspection = host.inspect();
    expect(inspection).toHaveLength(catalog.definitions.length);
    for (const { manifest } of catalog.definitions) {
      const module = inspection.find(
        (item) => item.definitionId === manifest.definitionId,
      );
      expect(module).toMatchObject({
        displayName: manifest.displayName,
        summary: manifest.summary,
        description: manifest.description,
      });
      for (const direction of ["consumes", "produces"] as const) {
        for (const kind of manifest[direction]) {
          if (!("kind" in kind)) continue;
          expect(module?.[direction]).toContainEqual(
            expect.objectContaining({
              kind: kind.kind,
              displayName: kind.displayName,
              description: kind.description,
            }),
          );
          expect(textViolations("displayName", kind.displayName)).toEqual([]);
          expect(textViolations("description", kind.description)).toEqual([]);
        }
      }
    }
  });
});
