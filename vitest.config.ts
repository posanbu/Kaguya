/**
 * 功能概述：定义整个工作区的 Vitest 收集与执行策略，确保源码门禁和包级测试使用同一配置。
 * 主要职责：保留 Vitest 默认排除项并明确排除构建产物；`maxWorkers` 将同时初始化独立 PGlite
 * WASM 实例的工作数限制为两个，避免默认 CPU 数量在本机造成初始化资源争用，但仍保留文件并发。
 * 代码库关系：根 `pnpm test` 和迁移聚焦命令都加载本文件；database/testing.ts 创建的 PGlite
 * 实例由多个 Runtime、database 与 Server 集成测试使用，因此此处是跨包资源调度的唯一位置。
 * 输入输出与副作用：只影响测试 runner 的进程并发和文件过滤，不改变生产 Runtime、测试超时或断言。
 */
import { defaultExclude, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...defaultExclude, "**/dist/**"],
    maxWorkers: 2,
  },
});
