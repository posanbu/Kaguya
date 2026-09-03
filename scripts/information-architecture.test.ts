/**
 * 功能概述：执行信息原子架构的静态边界检查，阻止已退役的事件身份、SQLite
 * 后端与兼容查询 API 再次进入 production TypeScript。
 * 主要职责：`collectProductionSources` 遍历 packages/apps 并排除测试与构建产物；
 * `findViolations` 按标识符边界报告文件和行号，并以配置/Profile 管理文件白名单
 * 限定 `profileId` 的合法领域。
 * 代码库关系：由迁移验收和开发者直接通过 `pnpm exec tsx` 运行；它只读取源码，
 * 不导入业务包，因此能够在旧文件仍存在或公共导出已经无法编译时给出确定结果。
 * 输入输出与副作用：输入为当前仓库的 production `.ts`/`.tsx` 文件；成功时静默退出，
 * 发现违规时抛出包含全部位置的错误，不修改仓库内容。
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
] as const;

const forbidden: readonly ForbiddenRule[] = [
  { name: "EventEnvelope", pattern: /\bEventEnvelope\b/ },
  { name: "EventBus", pattern: /\bEventBus\b/ },
  { name: "defineEvent", pattern: /\bdefineEvent\b/ },
  { name: "defineListener", pattern: /\bdefineListener\b/ },
  { name: "traceId", pattern: /\btraceId\b/ },
  { name: "eventId", pattern: /\beventId\b/ },
  { name: "messageId", pattern: /\bmessageId\b/ },
  { name: "runId", pattern: /\brunId\b/ },
  { name: "MessageRecord", pattern: /\bMessageRecord\b/ },
  { name: "EventRun", pattern: /\bEventRun\b/ },
  { name: "LlmTrace", pattern: /\bLlmTrace\b/ },
  { name: "OutboundMessageRecord", pattern: /\bOutboundMessageRecord\b/ },
  { name: "node:sqlite", pattern: /\bnode:sqlite\b/ },
  { name: "getById", pattern: /\bgetById\b/ },
  { name: "listByReference", pattern: /\blistByReference\b/ },
];

const sources = await collectProductionSources();
const violations = await findViolations(sources);

if (violations.length > 0) {
  throw new Error(
    `Information architecture violations:\n${violations
      .map((violation) => `- ${violation}`)
      .join("\n")}`,
  );
}

async function collectProductionSources(): Promise<readonly string[]> {
  const files = (
    await Promise.all(
      productionRoots.map((root) => walk(resolve(repositoryRoot, root))),
    )
  ).flat();

  return files
    .map((file) => relative(repositoryRoot, file))
    .filter(isProductionTypeScript)
    .sort();
}

async function walk(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? walk(path) : [path];
    }),
  );
  return nested.flat();
}

function isProductionTypeScript(path: string): boolean {
  return (
    (path.endsWith(".ts") || path.endsWith(".tsx")) &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".test.tsx") &&
    !path.includes("/dist/") &&
    !path.startsWith("docs/ours/")
  );
}

async function findViolations(
  paths: readonly string[],
): Promise<readonly string[]> {
  const violations: string[] = [];

  for (const path of paths) {
    const source = await readFile(resolve(repositoryRoot, path), "utf8");
    const lines = source.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const rule of forbidden) {
        if (rule.pattern.test(line)) {
          violations.push(`${path}:${index + 1}: ${rule.name}`);
        }
      }
      if (
        /\bprofileId\b/.test(line) &&
        !profileIdAllowedPaths.some((allowedPath) =>
          allowedPath.endsWith("/")
            ? path.startsWith(allowedPath)
            : path === allowedPath,
        )
      ) {
        violations.push(`${path}:${index + 1}: profileId`);
      }
    }
  }

  return violations;
}
