/**
 * 功能概述：执行并测试信息原子架构的静态边界检查，阻止已退役事件身份、SQLite、
 * 兼容 wrapper/别名以及旧工作流 API 再次进入 production TypeScript。
 * 主要职责：`collectProductionSources` 以 POSIX 相对路径遍历 packages/apps；
 * `isProductionTypeScript` 和 `findSourceViolations` 是可独立测试的纯函数；唯一额外
 * profileId 白名单是 schema 的拒绝实现本身；`scanInformationArchitecture` 供 CLI 和
 * Vitest 共用同一次扫描逻辑，`main` 汇总违规并以非零失败。
 * 代码库关系：迁移验收通过 `pnpm exec tsx scripts/information-architecture.test.ts` 调用；
 * 根 `pnpm test` 也收集本文件，防止此前零测试 suite 的配置回归。
 * 输入输出与副作用：扫描只读取 production .ts/.tsx；路径先正规化为 POSIX，因而 Windows
 * 的 test、dist 与 docs exclusions 和 Profile 白名单与其他平台行为一致，不修改仓库内容。
 */
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface ForbiddenRule {
  readonly name: string;
  readonly pattern: RegExp;
}

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const productionRoots = ["packages", "apps"] as const;
const profileIdAllowedPaths = [
  "packages/config/",
  "apps/server/src/app.ts",
  "apps/server/src/setup.ts",
  "apps/web/src/App.tsx",
  "apps/web/src/api.ts",
  "apps/web/src/profile-editor.ts",
  "packages/schema/src/information.ts",
] as const;
const forbidden: readonly ForbiddenRule[] = [
  { name: "EventEnvelope", pattern: /\bEventEnvelope\b/ },
  { name: "EventBus", pattern: /\bEventBus\b/ },
  { name: "defineEvent", pattern: /\bdefineEvent\b/ },
  { name: "defineListener", pattern: /\bdefineListener\b/ },
  { name: "WorkflowEngine", pattern: /\bWorkflowEngine\b/ },
  { name: "defineModule", pattern: /\bdefineModule\b/ },
  { name: "defineNode", pattern: /\bdefineNode\b/ },
  { name: "defineWorkflow", pattern: /\bdefineWorkflow\b/ },
  { name: "onEvent", pattern: /\bonEvent\b/ },
  { name: "onTargetedEvent", pattern: /\bonTargetedEvent\b/ },
  { name: "traceId", pattern: /\btraceId\b/ },
  { name: "eventId", pattern: /\beventId\b/ },
  { name: "messageId", pattern: /\bmessageId\b/ },
  { name: "runId", pattern: /\brunId\b/ },
  { name: "MessageRecord", pattern: /\bMessageRecord\b/ },
  { name: "EventRun", pattern: /\bEventRun\b/ },
  { name: "LlmTrace", pattern: /\bLlmTrace\b/ },
  { name: "OutboundMessageRecord", pattern: /\bOutboundMessageRecord\b/ },
  { name: "PostgresKaguyaDatabase", pattern: /\bPostgresKaguyaDatabase\b/ },
  { name: "InformationModuleHost", pattern: /\bInformationModuleHost\b/ },
  { name: "InformationAtomStore", pattern: /\bInformationAtomStore\b/ },
  { name: "InformationAppendInput", pattern: /\bInformationAppendInput\b/ },
  { name: "PlatformReplySender", pattern: /\bPlatformReplySender\b/ },
  { name: "sendTextReply", pattern: /\bsendTextReply\b/ },
  { name: "InboundReceipt.delivery", pattern: /\breadonly\s+delivery\??\s*:/ },
  { name: "node:sqlite", pattern: /\bnode:sqlite\b/ },
  { name: "getById", pattern: /\bgetById\b/ },
  { name: "listByReference", pattern: /\blistByReference\b/ },
];

export function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function isProductionTypeScript(path: string): boolean {
  const normalized = toPosixPath(path);
  return (
    (normalized.endsWith(".ts") || normalized.endsWith(".tsx")) &&
    !normalized.endsWith(".test.ts") &&
    !normalized.endsWith(".test.tsx") &&
    !normalized.includes("/dist/") &&
    !normalized.startsWith("docs/ours/")
  );
}

export function isProfileIdAllowedPath(path: string): boolean {
  const normalized = toPosixPath(path);
  return profileIdAllowedPaths.some((allowedPath) =>
    allowedPath.endsWith("/")
      ? normalized.startsWith(allowedPath)
      : normalized === allowedPath,
  );
}

export function findSourceViolations(
  path: string,
  source: string,
): readonly string[] {
  const normalizedPath = toPosixPath(path);
  const violations: string[] = [];
  for (const [index, line] of source.split("\n").entries()) {
    for (const rule of forbidden) {
      if (rule.pattern.test(line)) {
        violations.push(`${normalizedPath}:${index + 1}: ${rule.name}`);
      }
    }
    if (/\bprofileId\b/.test(line) && !isProfileIdAllowedPath(normalizedPath)) {
      violations.push(`${normalizedPath}:${index + 1}: profileId`);
    }
  }
  return violations;
}

export async function collectProductionSources(): Promise<readonly string[]> {
  const files = (
    await Promise.all(
      productionRoots.map((root) => walk(resolve(repositoryRoot, root))),
    )
  ).flat();
  return files
    .map((file) => toPosixPath(relative(repositoryRoot, file)))
    .filter(isProductionTypeScript)
    .sort();
}

async function walk(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) => {
        const path = resolve(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      }),
    )
  ).flat();
}

async function findViolations(
  paths: readonly string[],
): Promise<readonly string[]> {
  return (
    await Promise.all(
      paths.map(async (path) =>
        findSourceViolations(
          path,
          await readFile(resolve(repositoryRoot, path), "utf8"),
        ),
      ),
    )
  ).flat();
}

export async function scanInformationArchitecture(): Promise<
  readonly string[]
> {
  return findViolations(await collectProductionSources());
}

async function main(): Promise<void> {
  const violations = await scanInformationArchitecture();
  if (violations.length > 0) {
    throw new Error(
      `Information architecture violations:\n${violations.map((violation) => `- ${violation}`).join("\n")}`,
    );
  }
}

if (process.env.VITEST) {
  const { describe, expect, it } = await import("vitest");
  describe("information architecture source selection", () => {
    it("normalizes Windows paths before checking production exclusions", () => {
      expect(isProductionTypeScript("packages\\runtime\\src\\index.ts")).toBe(
        true,
      );
      expect(
        isProductionTypeScript("packages\\runtime\\src\\index.test.ts"),
      ).toBe(false);
      expect(isProductionTypeScript("packages\\runtime\\dist\\index.ts")).toBe(
        false,
      );
    });

    it("applies the Profile whitelist and forbidden scan to POSIX paths", () => {
      expect(isProfileIdAllowedPath("packages\\config\\src\\profiles.ts")).toBe(
        true,
      );
      expect(
        isProfileIdAllowedPath("packages\\schema\\src\\information.ts"),
      ).toBe(true);
      expect(
        findSourceViolations(
          "packages\\runtime\\src\\legacy.ts",
          "const workflow = new WorkflowEngine();\nconst profileId = 'bad';",
        ),
      ).toEqual([
        "packages/runtime/src/legacy.ts:1: WorkflowEngine",
        "packages/runtime/src/legacy.ts:2: profileId",
      ]);
    });

    it("scans the current production workspace", async () => {
      await expect(scanInformationArchitecture()).resolves.toEqual([]);
    });
  });
} else {
  await main();
}
