/**
 * 功能概述：汇总 Runtime 的公开 API，在分阶段迁移期间同时保留待 Task 6 删除的旧事件文件，
 * 并导出信息原子版 kind、LLM lifecycle 与 `KaguyaRuntime` ingress。
 * 主要职责：稳定 re-export，不创建数据库、Core、模块或 transport；`information-kinds` 与
 * `runtime` 是 Task 4 新生产路径，dispatch/events/services/workflows 仅是暂存兼容出口。
 * 代码库关系：apps/server、demo 和 Task 5 adapters 从包入口消费 Runtime；Task 6 会删除旧出口，
 * 因此本文件不提供 Event 到 Information 的桥接或重复 definition。
 * 输入输出与副作用：仅静态导出符号，无运行时 I/O；所有 kind definition 保持其原始对象身份。
 */
export * from "./dispatch.js";
export * from "./events.js";
export * from "./gateway-allowlist.js";
export * from "./information-kinds.js";
export * from "./llm-lifecycle.js";
export * from "./runtime.js";
export * from "./services.js";
export * from "./workflows.js";
