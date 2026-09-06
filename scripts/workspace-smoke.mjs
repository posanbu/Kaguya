/**
 * 功能概述：执行仓库级轻量 smoke check，确认根工作区脚本与信息架构检查入口存在。
 * 主要职责：读取根 `package.json` 并检查日常 build/typecheck/lint/test/demo 命令；读取
 * `information-architecture.test.ts` 以保证迁移后静态边界脚本不会从工作区丢失。
 * 代码库关系：供本地初始化与 CI 的快速仓库形状检查使用；完整架构规则由 TS 脚本执行。
 * 输入输出与副作用：只读取仓库文件，缺失项会抛错并令进程非零退出，不修改工作区。
 */
import { readFile } from "node:fs/promises";

const root = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expected = ["build", "typecheck", "lint", "test", "prompt:test", "demo"];
for (const script of expected) {
  if (!root.scripts?.[script]) {
    throw new Error(`missing root script: ${script}`);
  }
}

await readFile(new URL("./information-architecture.test.ts", import.meta.url));
